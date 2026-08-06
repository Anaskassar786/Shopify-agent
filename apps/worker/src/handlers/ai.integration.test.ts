import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "@profit/db";
import {
  actionExecutions,
  aiRuns,
  auditLogs,
  dailyMetrics,
  notifications,
  recommendations,
  recommendationEvents,
  revenueMetrics,
  shopifyCustomers,
  storeSettings,
  withStoreScope,
  type ProfitDb,
} from "@profit/db";
import { channelFor } from "@profit/notifications";
import { upsertCheckouts } from "@profit/sync";
import {
  AiExecuteEmailActionJob,
  AiNightlyTickJob,
  AiRunJob,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type EmailSender,
} from "@profit/ai";
import { AiRunTrigger, ModelTier } from "@profit/types";
import {
  buildWorkerTestEnvironment,
  jsonResponse,
  type WorkerTestEnvironment,
} from "../test-support/harness";

/**
 * AI plane worker contract (P3 pipeline end-to-end): nightly tick → per-store
 * run → rules → scripted provider → autopilot → execution enqueue → tool
 * execution (discount + email) → audit + realtime. Network edges stubbed only
 * (Shopify admin API); provider and email sender are injected boundaries.
 */

class StubProvider implements AiProvider {
  readonly id = "GEMINI" as const;
  readonly calls: string[] = [];
  constructor(private readonly draftsByAgent: Record<string, unknown[]>) {}
  modelFor(_tier: ModelTier): string {
    return "stub-gemini";
  }
  async generate<TOutput>(request: AiGenerateRequest<TOutput>): Promise<AiGenerateResult<TOutput>> {
    this.calls.push(request.agentId);
    const drafts = this.draftsByAgent[request.agentId] ?? [];
    const output = { drafts } as TOutput;
    return {
      output,
      rawJson: JSON.stringify(output),
      model: "stub-gemini",
      usage: { inputTokens: 900, outputTokens: 220, costMicros: 175, latencyMs: 40 },
    };
  }
}

class CaptureSender implements EmailSender {
  readonly sent: { to: string; subject: string }[] = [];
  async send(input: { to: string; subject: string; htmlBody: string; textBody: string }) {
    this.sent.push(input);
    return { messageId: `<w-${this.sent.length}>` };
  }
}

function draftFor(firingRef: string, confidence: number) {
  return {
    firingRef,
    title: "Recover Mia's cart",
    description: "A high-value cart was abandoned 9 hours ago.",
    reasoning: ["Cart value $48.00", "Fresh abandonment converts best"],
    confidence,
    priority: "HIGH",
    risk: "LOW",
    emailDraft: {
      subject: "Your cart is waiting",
      body: "We kept your items aside.\n\nComplete your order while stock lasts.",
      ctaLabel: "Complete order",
    },
  };
}

async function seedRichAnalytics(db: ProfitDb, storeId: string): Promise<void> {
  const dailyRows: (typeof dailyMetrics.$inferInsert)[] = [];
  const revRows: (typeof revenueMetrics.$inferInsert)[] = [];
  for (let i = 1; i <= 30; i += 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    dailyRows.push({
      storeId,
      metricDate: day,
      ordersCount: 4,
      cancelledOrders: 0,
      itemsSold: 8,
      newCustomers: 1,
      returningCustomers: 2,
      aovCents: 5_000,
    });
    revRows.push({
      storeId,
      metricDate: day,
      grossSalesCents: 20_000,
      discountsCents: 500,
      refundsCents: 0,
      netSalesCents: 20_000,
      taxesCents: 0,
      shippingCents: 0,
      currency: "USD",
    });
  }
  await db.insert(dailyMetrics).values(dailyRows);
  await db.insert(revenueMetrics).values(revRows);
}

async function seedThinCustomerBase(db: ProfitDb, storeId: string): Promise<void> {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => ({
    storeId,
    shopifyCustomerId: `wc-${n}`,
    email: `win-${n}@example.com`,
    ordersCount: 2,
    totalSpent: "200.00",
    shopifyCreatedAt: new Date(Date.now() - 200 * 86_400_000),
  }));
  await db.insert(shopifyCustomers).values(rows);
}

describe("AI failsafe (provider not configured)", () => {
  let env: WorkerTestEnvironment;

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment(); // aiProvider: null by default
  });
  afterAll(async () => {
    await env.close();
  });

  it("a manual run lands PROVIDER_UNAVAILABLE, notifies the merchant, executes nothing", async () => {
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      AiRunJob,
      { storeId: env.storeId, trigger: AiRunTrigger.Manual },
      { jobId: `ai:test-failsafe:${env.storeId}` },
    );
    await env.settle();

    const runs = await env.db.select().from(aiRuns).where(eq(aiRuns.storeId, env.storeId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("PROVIDER_UNAVAILABLE");

    const notes = await env.db
      .select()
      .from(notifications)
      .where(eq(notifications.storeId, env.storeId));
    expect(notes.some((n) => n.title === "AI provider not configured")).toBe(true);

    const recs = await env.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.storeId, env.storeId));
    expect(recs).toHaveLength(0);

    const audits = await env.db.select().from(auditLogs).where(eq(auditLogs.storeId, env.storeId));
    expect(audits.some((a) => a.action === "ai.run.completed")).toBe(true);
  });
});

describe("AI revenue loop end-to-end via nightly tick", () => {
  let env: WorkerTestEnvironment;
  const sender = new CaptureSender();
  const published: unknown[] = [];

  beforeAll(async () => {
    const provider = new StubProvider({
      REVENUE_RECOVERY: [draftFor("cart:loop-1", 86)],
    });
    env = await buildWorkerTestEnvironment({ aiProvider: provider, emailSender: sender });
    await env.pubsub.subscribe(channelFor(env.storeId), (message) => {
      published.push((message as { payload: unknown }).payload);
      return Promise.resolve();
    });

    // FULLY_AUTOMATIC merchant policy with autopilot caps that the run fits inside.
    await env.db.insert(storeSettings).values({
      storeId: env.storeId,
      aiPreferences: {},
      automationPreferences: {
        mode: "FULLY_AUTOMATIC",
        abandonedCart: { enabled: true, delayHours: 6, minCartValueCents: 0, discountPercent: 10 },
        autopilot: { maxDiscountPercent: 20, maxEstimatedRevenueCents: 1_000_000 },
      },
      featureOverrides: {},
      branding: {},
    });

    await seedRichAnalytics(env.db, env.storeId);
    await seedThinCustomerBase(env.db, env.storeId);
    const nineHoursAgo = new Date(Date.now() - 9 * 3_600_000);
    await upsertCheckouts(env.db, env.storeId, [
      {
        id: "ck-1",
        token: "loop-1",
        email: "mia@example.com",
        currency: "USD",
        total_price: "48.00",
        abandoned_checkout_url: "https://checkout.example/loop-1",
        web_url: null,
        completed_at: null,
        closed_at: null,
        line_items: [{ id: "li-1", product_id: "p1", variant_id: null, title: "Runner", quantity: 1, price: "48.00" }],
        created_at: nineHoursAgo,
        updated_at: nineHoursAgo,
      },
    ]);

    // Shopify admin edge: discount creation sequence.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/price_rules.json")) {
          return jsonResponse({ price_rule: { id: 9101 } }, { status: 201 });
        }
        return jsonResponse({ discount_code: { id: 77, code: "PT-LOOPTEST" } }, { status: 201 });
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env.close();
  });

  it("tick fans out, run auto-approves inside policy, execution sends the email", async () => {
    await env.deps.persistence.enqueuePersistent(env.queue, AiNightlyTickJob, {}, {
      jobId: "ai:tick-test",
    });
    await env.settle();

    // Run row: COMPLETED, autopilot path.
    const runs = await env.db.select().from(aiRuns).where(eq(aiRuns.storeId, env.storeId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("COMPLETED");
    expect(runs[0]!.recommendationsCreated).toBe(1);

    // Recommendation went the whole way: PENDING → AUTO_APPROVED → QUEUED → EXECUTED.
    const recs = await env.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.storeId, env.storeId));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe("EXECUTED");

    const events = await withStoreScope(env.db, env.storeId, async (tx) =>
      tx
        .select()
        .from(recommendationEvents)
        .where(eq(recommendationEvents.recommendationId, recs[0]!.id)),
    );
    expect(events.map((e) => e.event)).toEqual([
      "CREATED",
      "AUTO_APPROVED",
      "EXECUTION_QUEUED",
      "EXECUTED",
    ]);

    // Execution row succeeded; the email actually left through the sender port.
    const executions = await env.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.recommendationId, recs[0]!.id));
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe("SUCCEEDED");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("mia@example.com");

    // Audit + realtime evidence of the whole loop.
    const audits = await env.db.select().from(auditLogs).where(eq(auditLogs.storeId, env.storeId));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("ai.run.completed");
    expect(actions).toContain("ai.action.executed");

    const kinds = (published as { kind?: string }[])
      .map((event) => event.kind)
      .filter((kind): kind is string => typeof kind === "string");
    expect(kinds).toContain("recommendation.created");
    expect(kinds).toContain("recommendation.executed");
  });
});

describe("execution failure path (P3: never silently dead-end)", () => {
  let envTwo: WorkerTestEnvironment;

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ price_rule: { id: 9202 } }, { status: 201 })),
    );
    envTwo = await buildWorkerTestEnvironment({ emailSender: new CaptureSender() });
    await envTwo.db.insert(storeSettings).values({
      storeId: envTwo.storeId,
      aiPreferences: {},
      automationPreferences: {},
      featureOverrides: {},
      branding: {},
    });
    // The checkout completed before the execution ran — recovery is pointless.
    const completedAt = new Date(Date.now() - 2 * 3_600_000);
    await upsertCheckouts(envTwo.db, envTwo.storeId, [
      {
        id: "ck-done",
        token: "done-1",
        email: "done@example.com",
        currency: "USD",
        total_price: "30.00",
        abandoned_checkout_url: "https://checkout.example/done-1",
        web_url: null,
        completed_at: completedAt,
        closed_at: null,
        line_items: [],
        created_at: new Date(Date.now() - 30 * 3_600_000),
        updated_at: completedAt,
      },
    ]);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await envTwo.close();
  });

  it("typed failure flips the recommendation to FAILED and notifies the merchant", async () => {
    const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
    const recRows = await withStoreScope(envTwo.db, envTwo.storeId, async (tx) =>
      tx
        .insert(recommendations)
        .values({
          storeId: envTwo.storeId,
          fingerprint,
          type: "RECOVER_ABANDONED_CART",
          agentId: "REVENUE_RECOVERY",
          ruleId: "cart.abandoned-recovery",
          title: "Recover a completed cart",
          description: "d",
          reasoning: ["a", "b"],
          priority: "HIGH",
          confidence: 80,
          riskLevel: "LOW",
          estimatedRevenueCents: 720,
          estimatedCostCents: 0,
          subjects: { checkoutTokens: ["done-1"] },
          actionType: "SEND_RECOVERY_EMAIL",
          actionParams: {
            template: "RECOVERY",
            checkoutToken: "done-1",
            discountPercent: 0,
            emailDraft: { subject: "s", body: "b\n\nmore", ctaLabel: "c" },
          },
          status: "APPROVED",
          decidedAt: new Date(),
        })
        .returning({ id: recommendations.id }),
    );
    const recId = recRows[0]!.id;

    const executionId = await withStoreScope(envTwo.db, envTwo.storeId, async (tx) =>
      tx
        .insert(actionExecutions)
        .values({
          storeId: envTwo.storeId,
          recommendationId: recId,
          actionType: "SEND_RECOVERY_EMAIL",
          status: "PENDING",
          idempotencyKey: createHash("sha256").update(`${recId}|email|v1`).digest("hex"),
          actionPreview: {},
        })
        .returning({ id: actionExecutions.id }),
    ).then((rows) => rows[0]!.id);

    await envTwo.deps.persistence.enqueuePersistent(
      envTwo.queue,
      AiExecuteEmailActionJob,
      { storeId: envTwo.storeId, recommendationId: recId, executionId },
      { jobId: `aiexec:${executionId}` },
    );
    await envTwo.settle();

    const rec = (
      await envTwo.db.select().from(recommendations).where(eq(recommendations.id, recId))
    )[0]!;
    expect(rec.status).toBe("FAILED");

    const executions = await envTwo.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.id, executionId));
    expect(executions[0]!.status).toBe("FAILED");
    expect(executions[0]!.errorMessage).toContain("completed");

    const notes = await envTwo.db
      .select()
      .from(notifications)
      .where(eq(notifications.storeId, envTwo.storeId));
    expect(notes.some((n) => n.title === "An automation action failed")).toBe(true);

    const audits = await envTwo.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.storeId, envTwo.storeId));
    expect(audits.some((a) => a.action === "ai.action.failed")).toBe(true);
  });
});
