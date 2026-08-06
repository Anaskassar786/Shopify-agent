import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "@profit/db";
import { actionExecutions, recommendations, withStoreScope } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { RecommendationStatus } from "@profit/types";
import { executeAction, type ExecutorDeps } from "./executor";
import type { EmailSender } from "../tools/port";
import { bootAiTestDb, seedCheckout, seedCustomers, seedStore } from "../test-support/integration";

/**
 * Executor contract (PGlite + RLS, stubbed ONLY at the two network edges:
 * Shopify fetch and the email port). Proves: tool chaining, checkpoint
 * idempotency, consent enforcement, typed failures, state transitions.
 */

let testDb: TestDatabase;
let storeId = "";

class CaptureSender implements EmailSender {
  readonly sent: { to: string; subject: string; htmlBody: string }[] = [];
  async send(input: { to: string; subject: string; htmlBody: string; textBody: string }) {
    this.sent.push(input);
    return { messageId: `<x-${this.sent.length}>` };
  }
}

const branding = { storeName: "Demo Store", logoUrl: null, primaryColor: "#111111", supportEmail: null };
const admin = { shopDomain: "demo.myshopify.com", accessToken: "tok", apiVersion: "2025-10" };

function makeDeps(emailSender: EmailSender | null): ExecutorDeps {
  return {
    db: testDb.db,
    admin,
    email: emailSender,
    branding,
    shopDomain: "demo.myshopify.com",
  };
}

function stubShopifyDiscountFlow() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/price_rules.json")) {
        return new Response(JSON.stringify({ price_rule: { id: 9001 } }), { status: 201 });
      }
      return new Response(
        JSON.stringify({ discount_code: { id: 42, code: "PT-FLOWTEST" } }),
        { status: 201 },
      );
    }),
  );
  return calls;
}

async function insertRec(overrides: Partial<typeof recommendations.$inferInsert> = {}): Promise<string> {
  const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
    tx
      .insert(recommendations)
      .values({
        storeId,
        fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
        type: "RECOVER_ABANDONED_CART",
        agentId: "REVENUE_RECOVERY",
        ruleId: "cart.abandoned-recovery",
        title: "Rec",
        description: "desc",
        reasoning: ["a", "b"],
        priority: "HIGH",
        confidence: 85,
        riskLevel: "LOW",
        estimatedRevenueCents: 1_152,
        estimatedCostCents: 960,
        subjects: { checkoutTokens: ["exec-1"] },
        actionType: "SEND_RECOVERY_EMAIL",
        actionParams: {
          template: "RECOVERY",
          checkoutToken: "exec-1",
          discountPercent: 10,
          emailDraft: {
            subject: "Your cart is waiting",
            body: "We kept it aside for you.\n\nComplete before stock runs out.",
            ctaLabel: "Complete order",
          },
        },
        status: RecommendationStatus.Approved,
        expiresAt: null,
        ...overrides,
      })
      .returning({ id: recommendations.id }),
  );
  return rows[0]!.id;
}

async function insertExecution(recId: string, actionType: string): Promise<string> {
  const key = createHash("sha256").update(`${recId}|${actionType}|v1`).digest("hex");
  const rows = await withStoreScope(testDb.db, storeId, async (tx) =>
    tx
      .insert(actionExecutions)
      .values({
        storeId,
        recommendationId: recId,
        actionType: actionType as typeof actionExecutions.$inferInsert.actionType,
        status: "PENDING",
        idempotencyKey: key,
        actionPreview: {},
      })
      .returning({ id: actionExecutions.id }),
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  testDb = await bootAiTestDb();
  storeId = await seedStore(testDb.db, { shopDomain: "exec-store.myshopify.com" });
  await seedCheckout(testDb.db, storeId, { token: "exec-1", email: "buyer@example.com", hoursAgo: 9 });
  await seedCustomers(testDb.db, storeId, [
    { shopifyId: "w1", email: "yes@example.com", firstName: "Yes", acceptsMarketing: true, orders: 3 },
    { shopifyId: "w2", email: "no@example.com", firstName: "No", acceptsMarketing: false, orders: 3 },
  ]);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await testDb.close();
});

describe("RECOVERY execution (discount → email chain)", () => {
  it("creates the discount, sends the email, transitions to EXECUTED with checkpoints", async () => {
    const sender = new CaptureSender();
    const calls = stubShopifyDiscountFlow();
    const recId = await insertRec();
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");

    const outcome = await executeAction(makeDeps(sender), { storeId, recommendationId: recId, executionId });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(2);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("buyer@example.com");
    expect(sender.sent[0]!.htmlBody).toContain("Hi there,"); // checkout has no linked customer name

    const executions = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(actionExecutions).where(eq(actionExecutions.id, executionId)),
    );
    expect(executions[0]!.status).toBe("SUCCEEDED");
    const ref = executions[0]!.toolRef as Record<string, unknown>;
    expect(ref["priceRuleId"]).toBe("9001");
    expect(ref["discountCode"]).toBeDefined();
    expect((ref["sentTo"] as string[])[0]).toBe("buyer@example.com");

    const rec = (
      await withStoreScope(testDb.db, storeId, async (tx) =>
        tx.select().from(recommendations).where(eq(recommendations.id, recId)))
    )[0]!;
    expect(rec.status).toBe(RecommendationStatus.Executed);

    // Idempotent replay: second run is a SUCCEEDED no-op (no new sends/calls).
    const again = await executeAction(makeDeps(sender), { storeId, recommendationId: recId, executionId });
    expect(again.status).toBe("SUCCEEDED");
    expect(sender.sent).toHaveLength(1);
  });
});

describe("WINBACK execution", () => {
  it("sends only to consented recipients (accepts_marketing)", async () => {
    const customers = await seedCustomers(testDb.db, storeId, [
      { shopifyId: "w3", email: null, firstName: "NoMail", acceptsMarketing: true, orders: 1 },
    ]);
    const w1 = (await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.query.shopifyCustomers.findMany({ where: (table, ops) => ops.eq(table.storeId, storeId) }),
    )).filter((row) => row.shopifyCustomerId !== "w3");
    const consented = w1.filter((row) => row.acceptsMarketing).map((row) => row.id);
    const recId = await insertRec({
      type: "WINBACK_INACTIVE",
      actionParams: {
        template: "WINBACK",
        discountPercent: 0,
        emailDraft: {
          subject: "We miss you",
          body: "It has been a while since your last visit.\n\nCome see what is new.",
          ctaLabel: "Shop new arrivals",
        },
      },
      subjects: { customerIds: consented },
    });
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const sender = new CaptureSender();
    const outcome = await executeAction(makeDeps(sender), { storeId, recommendationId: recId, executionId });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(sender.sent.map((mail) => mail.to)).toEqual(["yes@example.com"]);
    expect(sender.sent[0]!.htmlBody).toContain("Hi Yes,");
  });

  it("typed FAILED when checkout already completed (nothing to recover)", async () => {
    await seedCheckout(testDb.db, storeId, {
      token: "done-1",
      email: "buyer2@example.com",
      hoursAgo: 20,
      completed: true,
    });
    const recId = await insertRec({
      subjects: { checkoutTokens: ["done-1"] },
      actionParams: {
        template: "RECOVERY",
        checkoutToken: "done-1",
        discountPercent: 0,
        emailDraft: {
          subject: "Still there?",
          body: "Your items are one click away.\n\nFinish checkout in seconds.",
          ctaLabel: "Return",
        },
      },
    });
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const outcome = await executeAction(makeDeps(new CaptureSender()), {
      storeId, recommendationId: recId, executionId,
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toContain("completed");
    expect(outcome.retryable).toBe(false);
  });
});

describe("CREATE_DISCOUNT_CODE execution", () => {
  it("creates the discount and never touches email", async () => {
    const sender = new CaptureSender();
    const calls = stubShopifyDiscountFlow();
    const recId = await insertRec({
      type: "REMOVE_DEAD_STOCK",
      actionType: "CREATE_DISCOUNT_CODE",
      actionParams: { purpose: "CLEARANCE", discountPercent: 25, expiresInDays: 14 },
      subjects: { productIds: ["p1"] },
    });
    const executionId = await insertExecution(recId, "CREATE_DISCOUNT_CODE");
    const outcome = await executeAction(makeDeps(sender), { storeId, recommendationId: recId, executionId });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(2);
    expect(sender.sent).toHaveLength(0);
  });
});

describe("ADVISORY execution", () => {
  it("completes instantly with zero tool steps", async () => {
    const recId = await insertRec({
      type: "RESTOCK",
      actionType: "ADVISORY",
      actionParams: { note: "advisory.restock" },
      subjects: { productIds: ["p1"] },
    });
    const executionId = await insertExecution(recId, "ADVISORY");
    const sender = new CaptureSender();
    const outcome = await executeAction(makeDeps(sender), { storeId, recommendationId: recId, executionId });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(sender.sent).toHaveLength(0);
  });
});

describe("typed failure modes (failsafe — never execute uncertain actions)", () => {
  it("missing recommendation row fails closed, non-retryable", async () => {
    const recId = await insertRec();
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const outcome = await executeAction(makeDeps(new CaptureSender()), {
      storeId, recommendationId: randomUUID(), executionId, // payload drift: rec no longer matches
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toContain("missing");
    expect(outcome.retryable).toBe(false);
  });

  it("email action without a model-written draft refuses to send", async () => {
    const recId = await insertRec({
      actionParams: { template: "RECOVERY", checkoutToken: "exec-1", discountPercent: 0 }, // no emailDraft
    });
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const outcome = await executeAction(makeDeps(new CaptureSender()), {
      storeId, recommendationId: recId, executionId,
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toContain("emailDraft");
    expect(outcome.retryable).toBe(false);
  });

  it("WINBACK with zero consented recipients fails typed (consent is a hard gate)", async () => {
    const recId = await insertRec({
      type: "WINBACK_INACTIVE",
      actionType: "SEND_RECOVERY_EMAIL",
      subjects: { customerIds: ["55555555-5555-4555-8555-555555555555"] }, // valid uuid, matches no consented customer
      actionParams: {
        template: "WINBACK",
        discountPercent: 0,
        emailDraft: { subject: "We miss you", body: "Come back.\n\nSee what is new.", ctaLabel: "Browse" },
      },
    });
    // The seeded consented customer is not in subjects; the subject id resolves to nothing consented.
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const outcome = await executeAction(makeDeps(new CaptureSender()), {
      storeId, recommendationId: recId, executionId,
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.retryable).toBe(false);
  });

  it("email tool unavailable (no sender configured) fails typed without retry", async () => {
    const recId = await insertRec({
      actionParams: {
        template: "RECOVERY",
        checkoutToken: "exec-1",
        discountPercent: 0,
        emailDraft: { subject: "Waiting", body: "We saved your cart.\n\nFinish now.", ctaLabel: "Resume" },
      },
    });
    const executionId = await insertExecution(recId, "SEND_RECOVERY_EMAIL");
    const outcome = await executeAction(makeDeps(null), { storeId, recommendationId: recId, executionId });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.retryable).toBe(false);
  });

  it("discount with a zero percent is rejected by the server-side param builder", async () => {
    const recId = await insertRec({
      type: "REMOVE_DEAD_STOCK",
      actionType: "CREATE_DISCOUNT_CODE",
      actionParams: { purpose: "CLEARANCE", discountPercent: 0, expiresInDays: 14 },
      subjects: { productIds: ["p1"] },
    });
    const executionId = await insertExecution(recId, "CREATE_DISCOUNT_CODE");
    const outcome = await executeAction(makeDeps(new CaptureSender()), {
      storeId, recommendationId: recId, executionId,
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.errorMessage).toContain("percent");
    expect(outcome.retryable).toBe(false);
  });
});
