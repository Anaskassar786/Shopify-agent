import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, messageEvents, notifications, shopifyCustomers, users, workflowRuns, workflows } from "@profit/db";
import {
  AutomationTickJob,
  CampaignSendBatchJob,
  CampaignService,
  ExportGenerateJob,
  ExportService,
  SupportNotifyJob,
  SupportService,
  WorkflowRunStartJob,
  WorkflowService,
  type WorkflowDefinition,
} from "@profit/automation";
import { WebhookProcessJob } from "@profit/sync";
import {
  CampaignAudience,
  CampaignStatus,
  ExportFormat,
  ExportKind,
  ExportStatus,
  MessageChannel,
  MessageEventKind,
  PlanCode,
  ShopifyWebhookTopic,
  SubscriptionStatus,
  SupportTicketCategory,
  SupportTicketStatus,
  UserStatus,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import type { EmailSender } from "@profit/ai";
import {
  buildWorkerTestEnvironment,
  seedHarnessSubscription,
  type WorkerTestEnvironment,
} from "../test-support/harness";

/**
 * M6 Automation Center worker plane, end-to-end: TICK scheduler fan-out +
 * CAS cursor advance, DELAY resume across restarts, campaign dispatch →
 * throttled keyset send chain → convergent completion + notifications,
 * export generation, support reply fan-out, and webhook EVENT triggers —
 * all through the REAL registered handler graph; only the Shopify/SMTP/
 * Twilio network boundaries are faked.
 *
 * Semantics verified honestly: a SEND_EMAIL step with no customer context is
 * a TERMINAL step failure (the run ledger records FAILED + reason) — silent
 * skips are not acceptable for paid billing classification, and re-firing a
 * schedule instant or replaying a delivery never duplicates runs.
 */

const DAY = "2026-08-03T12:00:00Z";

let env: WorkerTestEnvironment;
const emailSent: Array<{ to: string; subject: string; textBody: string; htmlBody: string }> = [];
const emailSender: EmailSender = {
  send: async (input) => {
    emailSent.push(input);
    return { messageId: `msg-${String(emailSent.length)}` };
  },
};

beforeEach(async () => {
  emailSent.length = 0;
  env = await buildWorkerTestEnvironment({ emailSender });
  await seedHarnessSubscription(env.db, env.storeId, {
    planCode: PlanCode.Professional,
    status: SubscriptionStatus.Active,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.close();
});

const WEEKLY_FLOW: WorkflowDefinition = {
  nodes: [
    {
      id: "trigger",
      kind: WorkflowNodeKind.Trigger,
      config: { kind: WorkflowTriggerKind.Schedule, cron: "0 9 * * 1" },
    },
    {
      id: "note",
      kind: WorkflowNodeKind.SendEmail,
      config: { subject: "Weekly", bodyText: "Digest body" },
    },
  ],
  edges: [{ from: "trigger", to: "note" }],
};

const DELAY_FLOW: WorkflowDefinition = {
  nodes: [
    { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
    { id: "wait", kind: WorkflowNodeKind.Delay, config: { minutes: 1 } },
    {
      id: "after",
      kind: WorkflowNodeKind.SendEmail,
      config: { subject: "Follow-up", bodyText: "After the wait." },
    },
  ],
  edges: [
    { from: "trigger", to: "wait" },
    { from: "wait", to: "after" },
  ],
};

const EVENT_FLOW: WorkflowDefinition = {
  nodes: [
    {
      id: "trigger",
      kind: WorkflowNodeKind.Trigger,
      config: { kind: WorkflowTriggerKind.Event, topic: ShopifyWebhookTopic.OrdersCreate },
    },
    {
      id: "thank",
      kind: WorkflowNodeKind.SendEmail,
      config: {
        subject: "Thanks {{customer.firstName}}",
        bodyText: "Order received at {{store.name}}.",
      },
    },
  ],
  edges: [{ from: "trigger", to: "thank" }],
};

async function activeWorkflow(definition: WorkflowDefinition): Promise<string> {
  const service = new WorkflowService(env.db);
  const { workflow, version } = await service.create(env.storeId, {
    name: `wf-${crypto.randomUUID().slice(0, 8)}`,
    definition,
  });
  await service.activate(env.storeId, workflow.id, version.id);
  return workflow.id;
}

async function runsOf(workflowId: string) {
  return env.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
}

async function fireTick(): Promise<void> {
  await env.deps.persistence.enqueuePersistent(env.queue, AutomationTickJob, {}, {
    jobId: `tick:${String(Date.now())}:${crypto.randomUUID()}`,
  });
  await env.settle();
}

describe("automation.tick — schedule fan-out + resume", () => {
  it("fires a due schedule exactly once, CAS-advances, fail-fasts truthfully", async () => {
    const workflowId = await activeWorkflow(WEEKLY_FLOW);
    const past = new Date(Date.now() - 60_000);
    await env.db.update(workflows).set({ nextFireAt: past }).where(eq(workflows.id, workflowId));

    await fireTick();

    const runs = await runsOf(workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggerKind).toBe(WorkflowTriggerKind.Schedule);
    expect(runs[0]!.triggerEventId).toBe(`schedule:${workflowId}:${String(past.getTime())}`);
    // SCHEDULE subjects carry no customer: the SEND_EMAIL step fails terminal,
    // and the ledger says exactly why (no silent skip semantics).
    expect(runs[0]!.status).toBe(WorkflowRunStatus.Failed);
    expect(runs[0]!.error).toContain("no customer email");

    // Cursor advanced past the fired instant; a second tick observes it.
    const after = await env.db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect(after[0]!.nextFireAt).not.toBeNull();
    expect(after[0]!.nextFireAt!.getTime()).toBeGreaterThan(past.getTime());
    await fireTick();
    expect(await runsOf(workflowId)).toHaveLength(1);
  });

  it("resumes a delay-elapsed WAITING run and finishes the walk", async () => {
    const workflowId = await activeWorkflow(DELAY_FLOW);
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      WorkflowRunStartJob,
      {
        storeId: env.storeId,
        workflowId,
        triggerKind: WorkflowTriggerKind.Manual,
        triggerEventId: `manual:${crypto.randomUUID()}`,
        subject: { customer: { email: "delays@x.com", firstName: "Dee" }, event: null },
      },
      { jobId: `start:${crypto.randomUUID()}` },
    );
    await env.settle();

    let runs = await runsOf(workflowId);
    expect(runs[0]!.status).toBe(WorkflowRunStatus.Waiting);
    expect(runs[0]!.resumeAt).not.toBeNull();

    // Time passes (simulate by ageing the resume cursor), TICK finds it due.
    await env.db
      .update(workflowRuns)
      .set({ resumeAt: new Date(Date.now() - 1_000) })
      .where(eq(workflowRuns.id, runs[0]!.id));
    await fireTick();

    runs = await runsOf(workflowId);
    expect(runs[0]!.status).toBe(WorkflowRunStatus.Completed);
    expect(emailSent.some((m) => m.to === "delays@x.com" && m.subject === "Follow-up")).toBe(true);
  });
});

describe("campaigns — dispatch → throttled send chain → convergent completion", () => {
  it("materializes the audience, sends tracked mail, completes and notifies", async () => {
    for (const [index, address] of ["a@x.com", "b@x.com"].entries()) {
      await env.db.insert(shopifyCustomers).values({
        storeId: env.storeId,
        shopifyCustomerId: `c${String(index)}`,
        email: address,
        acceptsMarketing: true,
      });
    }

    const campaigns = new CampaignService(env.db);
    const campaign = await campaigns.createCampaign(env.storeId, {
      name: "Worker blast",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "Hello there", bodyText: "Body" },
    });
    await campaigns.scheduleCampaign(env.storeId, campaign.id, new Date(Date.now() - 1_000));

    await fireTick();

    const after = await campaigns.getCampaign(env.storeId, campaign.id);
    expect(after?.status).toBe(CampaignStatus.Sent);
    expect(after?.sentCount).toBe(2);
    expect(emailSent).toHaveLength(2);
    expect(emailSent.every((m) => m.htmlBody.includes("https://api.profit.test/api/v1/t/o/"))).toBe(true);

    const events = await env.db
      .select()
      .from(messageEvents)
      .where(eq(messageEvents.campaignId, campaign.id));
    expect(events.filter((e) => e.kind === MessageEventKind.Sent)).toHaveLength(2);

    const notes = await env.db.select().from(notifications).where(eq(notifications.storeId, env.storeId));
    expect(notes.some((n) => n.title === "Campaign sent")).toBe(true);
  });

  it("replayed chain-start jobIds converge to exactly one send pass", async () => {
    await env.db.insert(shopifyCustomers).values({
      storeId: env.storeId,
      shopifyCustomerId: "solo",
      email: "solo@x.com",
    });
    const campaigns = new CampaignService(env.db);
    const campaign = await campaigns.createCampaign(env.storeId, {
      name: "chain-convergent",
      channel: MessageChannel.Email,
      audience: CampaignAudience.AllCustomers,
      variantA: { subject: "s", bodyText: "b" },
    });
    await campaigns.scheduleCampaign(env.storeId, campaign.id, new Date(Date.now() - 1_000));
    await campaigns.dispatch(env.storeId, campaign.id);

    // The SAME deterministic first-link jobId twice: queue + persistence dedupe.
    for (let i = 0; i < 2; i += 1) {
      await env.deps.persistence.enqueuePersistent(
        env.queue,
        CampaignSendBatchJob,
        { storeId: env.storeId, campaignId: campaign.id, afterRecipientId: null },
        { jobId: `campaign-send:${campaign.id}:cursor:start` },
      );
    }
    await env.settle();

    const after = await campaigns.getCampaign(env.storeId, campaign.id);
    expect(after?.status).toBe(CampaignStatus.Sent);
    expect(emailSent).toHaveLength(1);
  });
});

describe("exports.generate", () => {
  it("builds the CSV bytes, marks READY and notifies", async () => {
    await env.db.insert(shopifyCustomers).values({
      storeId: env.storeId,
      shopifyCustomerId: "ex-1",
      email: "export@x.com",
    });
    const exportsSvc = new ExportService(env.db);
    const requested = await exportsSvc.request(env.storeId, {
      kind: ExportKind.Customers,
      format: ExportFormat.Csv,
      requestedByUserId: null,
    });
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      ExportGenerateJob,
      { storeId: env.storeId, exportId: requested.id },
      { jobId: `export-generate:${requested.id}` },
    );
    await env.settle();

    const row = await exportsSvc.getExport(env.storeId, requested.id);
    expect(row?.status).toBe(ExportStatus.Ready);
    expect(row?.rowCount).toBe(1);
    const file = await exportsSvc.loadFile(env.storeId, requested.id);
    expect(file.data.toString("utf8").startsWith("﻿")).toBe(true); // BOM for Excel
    const notes = await env.db.select().from(notifications).where(eq(notifications.storeId, env.storeId));
    expect(notes.some((n) => n.title === "Export ready")).toBe(true);
  });
});

describe("support.notify", () => {
  it("emails the opener and leaves an in-app notification for an operator reply", async () => {
    const userRows = await env.db
      .insert(users)
      .values({ email: "owner@shop.test", fullName: "Owner", status: UserStatus.Active })
      .returning({ id: users.id });
    const userId = userRows[0]!.id;

    const support = new SupportService(env.db);
    const ticket = await support.createTicket(env.storeId, {
      openedByUserId: userId,
      subject: "Sync stuck",
      category: SupportTicketCategory.Data,
      body: "Products stopped syncing yesterday.",
    });
    const reply = await support.replyAsOperator(ticket.id, "ops-agent", "We replayed the sync — all good now.");

    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SupportNotifyJob,
      { storeId: env.storeId, ticketId: ticket.id, messageId: reply.messageId },
      { jobId: `support-notify:${reply.messageId}` },
    );
    await env.settle();

    expect(emailSent).toHaveLength(1);
    expect(emailSent[0]!.to).toBe("owner@shop.test");
    expect(emailSent[0]!.subject).toContain("Sync stuck");
    const after = await support.getTicket(env.storeId, ticket.id);
    expect(after?.ticket.status).toBe(SupportTicketStatus.WaitingOnCustomer);
    const notes = await env.db.select().from(notifications).where(eq(notifications.storeId, env.storeId));
    expect(notes.some((n) => n.title.includes("Support replied"))).toBe(true);
  });
});

describe("webhook EVENT fan-out", () => {
  it("orders/create starts the active event workflow exactly once per delivery", async () => {
    // The customers module has synced: the replica row anchors the run subject.
    await env.db.insert(shopifyCustomers).values({
      storeId: env.storeId,
      shopifyCustomerId: "777001",
      email: "buyer@example.com",
      firstName: "Dana",
      lastName: "Roe",
      ordersCount: 2,
      totalSpent: "124.00",
      acceptsMarketing: true,
    });
    const workflowId = await activeWorkflow(EVENT_FLOW);

    const payload = {
      id: 99001,
      name: "#99001",
      order_number: 99001,
      email: "buyer@example.com",
      financial_status: "paid",
      fulfillment_status: null,
      currency: "USD",
      subtotal_price: "55.00",
      total_discounts: "0.00",
      total_tax: "4.90",
      total_price: "59.90",
      total_shipping_price_set: { shop_money: { amount: "0.00" } },
      processed_at: DAY,
      cancelled_at: null,
      cancel_reason: null,
      created_at: DAY,
      updated_at: DAY,
      test: false,
      tags: "",
      customer: { id: 777001 },
      line_items: [],
    };
    const logId = await env.insertWebhookLog(ShopifyWebhookTopic.OrdersCreate, payload, "wh-evt-1");
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      WebhookProcessJob,
      { storeId: env.storeId, webhookLogId: logId },
      { jobId: `webhook-process:${logId}` },
    );
    await env.settle();

    const runs = await runsOf(workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggerKind).toBe(WorkflowTriggerKind.Event);
    expect(runs[0]!.triggerEventId).toBe(`webhook:${ShopifyWebhookTopic.OrdersCreate}:wh-evt-1`);
    expect(runs[0]!.status).toBe(WorkflowRunStatus.Completed);
    // Subject customer resolved from the replica row (email + firstName).
    expect(
      emailSent.some((m) => m.to === "buyer@example.com" && m.subject === "Thanks Dana" && m.textBody.includes("Worker Store")),
    ).toBe(true);

    // Re-enqueueing the delivery's process job converges: the webhook row is
    // already PROCESSED, so the fan-out never re-fires; even a forced fan-out
    // would deadlock on the run's unique triggerEventId.
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      WebhookProcessJob,
      { storeId: env.storeId, webhookLogId: logId },
      { jobId: `webhook-process-replay:${logId}` },
    );
    await env.settle();
    expect(await runsOf(workflowId)).toHaveLength(1);
  });
});
