import type { TestDatabase } from "@profit/db/testing";
import { SupportTicketCategory, SupportTicketPriority, SupportTicketStatus, TicketAuthorKind } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootAutomationTestDb, seedAutomationStore, seedUser, uniqueDomain } from "./test-support/integration";
import { SupportService, TicketNotFoundError, TicketStateError } from "./support.service";

/**
 * Support plane contract: merchant thread lifecycle, reopen semantics,
 * operator cross-tenant views/replies/transitions, notify payloads, and
 * validation — against the real schema.
 */

let testDb: TestDatabase;
let service: SupportService;
let storeId = "";
let otherStoreId = "";
let userId = "";

beforeAll(async () => {
  testDb = await bootAutomationTestDb();
  service = new SupportService(testDb.db);
  storeId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("support-a") });
  otherStoreId = await seedAutomationStore(testDb.db, { shopDomain: uniqueDomain("support-b") });
  userId = await seedUser(testDb.db, { email: "merchant@example.com" });
});

afterAll(async () => {
  await testDb.close();
});

describe("merchant lifecycle", () => {
  it("creates a ticket with its first message in one transaction", async () => {
    const ticket = await service.createTicket(storeId, {
      openedByUserId: userId,
      subject: "Dashboard numbers look stale",
      category: SupportTicketCategory.Data,
      priority: SupportTicketPriority.High,
      body: "Revenue did not move after the last sync.",
    });
    expect(ticket.status).toBe(SupportTicketStatus.Open);
    expect(ticket.messageCount).toBe(1);
    expect(ticket.operatorAttention).toBe(true);

    const detail = await service.getTicket(storeId, ticket.id);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.authorKind).toBe(TicketAuthorKind.Merchant);
    expect(detail?.messages[0]?.authorEmail).toBe("merchant@example.com");
  });

  it("validates subject and body bounds", async () => {
    await expect(
      service.createTicket(storeId, { openedByUserId: userId, subject: "", category: SupportTicketCategory.Bug, body: "x" }),
    ).rejects.toBeInstanceOf(TicketStateError);
    await expect(
      service.createTicket(storeId, { openedByUserId: userId, subject: "ok", category: SupportTicketCategory.Bug, body: "" }),
    ).rejects.toBeInstanceOf(TicketStateError);
    await expect(
      service.replyAsMerchant(storeId, "00000000-0000-0000-0000-000000000000", userId, "hi"),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it("merchant reply reopens RESOLVED and bumps counters atomically", async () => {
    const ticket = await service.createTicket(storeId, {
      openedByUserId: userId,
      subject: "Question on billing",
      category: SupportTicketCategory.Billing,
      body: "When does the trial end?",
    });
    const replied = await service.replyAsOperator(ticket.id, "operator@profittool.ai", "It ends on the date shown in Billing.");
    expect(replied.ticket.status).toBe(SupportTicketStatus.WaitingOnCustomer);
    expect(replied.ticket.assignedOperator).toBe("operator@profittool.ai");
    expect(replied.ticket.operatorAttention).toBe(false);

    const resolved = await service.operatorTransition(ticket.id, SupportTicketStatus.Resolved);
    expect(resolved.status).toBe(SupportTicketStatus.Resolved);
    expect(resolved.resolvedAt).not.toBeNull();

    const back = await service.replyAsMerchant(storeId, ticket.id, userId, "That page was blank for me.");
    expect(back.ticket.status).toBe(SupportTicketStatus.Open);
    expect(back.ticket.operatorAttention).toBe(true);
    expect(back.ticket.messageCount).toBe(3);
    expect(back.ticket.resolvedAt).toBeNull();

    const detail = await service.getTicket(storeId, ticket.id);
    expect(detail?.messages.map((m) => m.authorKind)).toEqual([
      TicketAuthorKind.Merchant,
      TicketAuthorKind.Operator,
      TicketAuthorKind.Merchant,
    ]);
  });

  it("closed tickets reject replies on both sides", async () => {
    const ticket = await service.createTicket(storeId, {
      openedByUserId: userId,
      subject: "Close me",
      category: SupportTicketCategory.Other,
      body: "Nothing further.",
    });
    const closed = await service.closeByMerchant(storeId, ticket.id);
    expect(closed.status).toBe(SupportTicketStatus.Closed);
    await expect(service.replyAsMerchant(storeId, ticket.id, userId, "again")).rejects.toBeInstanceOf(TicketStateError);
    await expect(service.replyAsOperator(ticket.id, "operator@profittool.ai", "again")).rejects.toBeInstanceOf(TicketStateError);
  });

  it("lists tenant tickets paginated; tenant B never sees tenant A", async () => {
    const list = await service.listTickets(storeId, 1, 2);
    expect(list.rows.length).toBeLessThanOrEqual(2);
    expect(list.total).toBeGreaterThanOrEqual(3);
    const otherList = await service.listTickets(otherStoreId, 1, 10);
    expect(otherList.rows).toHaveLength(0);
  });
});

describe("operator surface", () => {
  it("lists cross-tenant with store context and attention filter", async () => {
    const all = await service.listForOperators({ attentionOnly: false, page: 1, pageSize: 50 });
    expect(all.total).toBeGreaterThanOrEqual(3);
    const row = all.rows.find((r) => r.subject === "Dashboard numbers look stale");
    expect(row?.shopDomain).toContain(".myshopify.com");
    expect(row?.openerEmail).toBe("merchant@example.com");

    const attention = await service.listForOperators({ attentionOnly: true, page: 1, pageSize: 50 });
    // "Dashboard numbers look stale" still waits for operator, closed one is out.
    expect(attention.rows.some((r) => r.subject === "Close me")).toBe(false);
    expect(attention.rows.some((r) => r.subject === "Dashboard numbers look stale")).toBe(true);
  });

  it("operator close marks closedAt and clears attention", async () => {
    const ticket = await service.createTicket(storeId, {
      openedByUserId: userId,
      subject: "Operator-close",
      category: SupportTicketCategory.Feature,
      body: "Please build exports (they exist!).",
    });
    await service.replyAsOperator(ticket.id, "operator@profittool.ai", "They live in the Exports section.");
    const closed = await service.operatorTransition(ticket.id, SupportTicketStatus.Closed);
    expect(closed.status).toBe(SupportTicketStatus.Closed);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.operatorAttention).toBe(false);
  });

  it("notify context resolves opener email + message body for the mail job", async () => {
    const ticket = await service.createTicket(storeId, {
      openedByUserId: userId,
      subject: "Notify check",
      category: SupportTicketCategory.Bug,
      body: "Something broke.",
    });
    const replied = await service.replyAsOperator(ticket.id, "operator@profittool.ai", "We are on it.");
    const context = await service.loadNotifyContext(ticket.id, replied.messageId);
    expect(context?.openerEmail).toBe("merchant@example.com");
    expect(context?.subject).toBe("Notify check");
    expect(context?.body).toBe("We are on it.");
    expect(context?.operator).toBe("operator@profittool.ai");
    expect(context?.shopDomain).toContain(".myshopify.com");
  });
});
