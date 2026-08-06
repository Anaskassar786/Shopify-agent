import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@profit/db";
import {
  actionExecutions,
  aiCallLogs,
  aiRuns,
  recommendations,
  recommendationEvents,
  recommendationEvidence,
  withStoreScope,
} from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { users } from "@profit/db";
import { AiAgentId, AiRunTrigger, RecommendationStatus, RecommendationType, UserStatus } from "@profit/types";
import { DecisionService, type RunNotifier } from "./decision";
import { RecommendationService } from "./recommendations";
import { AiProviderError } from "../provider/port";
import { ScriptedProvider, makeAgentDraft } from "../test-support/fixtures";
import { bootAiTestDb, seedAnalytics, seedCheckout, seedCustomers, seedStore } from "../test-support/integration";

/**
 * Decision run contract against the REAL schema (PGlite + migrations 0000→0005
 * + RLS): full pipeline for one abandoned cart — context → rule → scripted
 * provider → calibration → dedupe → atomic persist (rec + evidence + events +
 * run + call logs) → notify. Also: failsafe, dedupe, autopilot.
 */

let testDb: TestDatabase;
let storeId = "";
const notifyCalls: { title: string; actionUrl: string | null }[] = [];
const published: Record<string, unknown>[] = [];

const notifier: RunNotifier = {
  notify: async (_storeId, input) => {
    notifyCalls.push({ title: input.title, actionUrl: input.actionUrl });
  },
  publish: async (_storeId, event) => {
    published.push(event);
  },
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => logger,
  level: "fatal",
} as never;

function providerForRecovery(): ScriptedProvider {
  return new ScriptedProvider([
    {
      match: (request) => request.agentId === AiAgentId.RevenueRecovery,
      output: { drafts: [makeAgentDraft({ firingRef: "cart:t1", confidence: 82 })] },
    },
  ]);
}

beforeAll(async () => {
  testDb = await bootAiTestDb();
  storeId = await seedStore(testDb.db, { shopDomain: "ai-decision.myshopify.com" });
  await seedAnalytics(testDb.db, storeId);
  await seedCustomers(testDb.db, storeId, [
    { shopifyId: "c1", email: "one@example.com", orders: 2 },
    { shopifyId: "c2", email: "two@example.com", orders: 2 },
    { shopifyId: "c3", email: "three@example.com", orders: 2 },
    { shopifyId: "c4", email: "four@example.com", orders: 2 },
    { shopifyId: "c5", email: "five@example.com", orders: 2 },
    { shopifyId: "c6", email: "six@example.com", orders: 2 },
  ]);
  await seedCheckout(testDb.db, storeId, { token: "t1", email: "mia@example.com", hoursAgo: 9 });
});

afterAll(async () => {
  await testDb.close();
});

describe("DecisionService.run (happy path)", () => {
  it("produces one recommendation with evidence, events, run + call log atomically", async () => {
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: providerForRecovery(),
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(storeId, AiRunTrigger.Scheduled);

    expect(summary.status).toBe("COMPLETED");
    expect(summary.created).toHaveLength(1);
    expect(summary.firings).toBe(1);
    expect(summary.agentCalls).toBe(1); // only RevenueRecovery had firings
    expect(summary.health.score).toBeGreaterThan(0);

    const createdId = summary.created[0]!.id;
    const rows = await withStoreScope(testDb.db, storeId, async (tx) => {
      return tx.select().from(recommendations).where(eq(recommendations.id, createdId));
    });
    const rec = rows[0]!;
    expect(rec.type).toBe("RECOVER_ABANDONED_CART");
    expect(rec.status).toBe(RecommendationStatus.PendingApproval);
    expect(rec.estimatedRevenueCents).toBe(1_152); // 12% of 9600 — deterministic
    expect(rec.estimatedCostCents).toBe(960); // 10% policy discount
    expect(rec.title).toContain("Alpha Runner");
    expect(rec.ruleId).toBe("cart.abandoned-recovery");
    expect(rec.confidence).toBe(82);

    const evidence = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationEvidence).where(eq(recommendationEvidence.recommendationId, createdId)),
    );
    expect(evidence).toHaveLength(1);
    const snapshot = evidence[0]!.snapshot as { model: { promptId: string }; estimates: { revenueCents: number } };
    expect(snapshot.model.promptId).toBe("agent.revenue_recovery");
    expect(snapshot.estimates.revenueCents).toBe(1_152);

    const events = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendationEvents).where(eq(recommendationEvents.recommendationId, createdId)),
    );
    expect(events.map((event) => event.event)).toEqual(["CREATED"]);

    const runs = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(aiRuns).where(eq(aiRuns.id, summary.runId!)),
    );
    expect(runs[0]!.status).toBe("COMPLETED");
    expect(runs[0]!.recommendationsCreated).toBe(1);
    expect((runs[0]!.usage as { calls: number }).calls).toBe(1);

    const calls = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(aiCallLogs).where(eq(aiCallLogs.runId, summary.runId!)),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("SUCCEEDED");
    expect(calls[0]!.costMicros).toBe(187);
    expect(calls[0]!.promptId).toBe("agent.revenue_recovery");

    expect(notifyCalls.some((call) => call.title.includes("1 new AI recommendation"))).toBe(true);
  });

  it("second run over identical data is a dedupe no-op (idempotency)", async () => {
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: providerForRecovery(),
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(storeId, AiRunTrigger.Scheduled);
    expect(summary.created).toHaveLength(0);
    expect(summary.duplicatesSkipped).toBe(1);

    const all = await withStoreScope(testDb.db, storeId, async (tx) =>
      tx.select().from(recommendations).where(eq(recommendations.storeId, storeId)),
    );
    expect(all).toHaveLength(1);
  });
});

describe("failsafe: provider absent", () => {
  it("lands PROVIDER_UNAVAILABLE, notifies, creates nothing (P3)", async () => {
    const altStore = await seedStore(testDb.db, { shopDomain: "ai-noprovider.myshopify.com" });
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: null,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(altStore, AiRunTrigger.Manual);
    expect(summary.status).toBe("PROVIDER_UNAVAILABLE");
    expect(summary.created).toHaveLength(0);
    expect(notifyCalls.some((call) => call.title === "AI provider not configured")).toBe(true);

    const count = await withStoreScope(testDb.db, altStore, async (tx) =>
      tx.select().from(recommendations).where(eq(recommendations.storeId, altStore)),
    );
    expect(count).toHaveLength(0);
  });
});

describe("autopilot: FULLY_AUTOMATIC policy", () => {
  it("auto-approves inside policy guardrails and queues the execution", async () => {
    const autoStore = await seedStore(testDb.db, {
      shopDomain: "ai-auto.myshopify.com",
      automation: {
        mode: "FULLY_AUTOMATIC",
        abandonedCart: { enabled: true, delayHours: 6, minCartValueCents: 0, discountPercent: 10 },
        autopilot: { maxDiscountPercent: 20, maxEstimatedRevenueCents: 100_000 },
      },
    });
    await seedAnalytics(testDb.db, autoStore);
    await seedCustomers(testDb.db, autoStore, [
      { shopifyId: "d1", email: "a@b.co", orders: 3 },
      { shopifyId: "d2", email: "c@d.co", orders: 2 },
      { shopifyId: "d3", email: "e@f.co", orders: 2 },
      { shopifyId: "d4", email: "g@h.co", orders: 5 },
      { shopifyId: "d5", email: "i@j.co", orders: 4 },
      { shopifyId: "d6", email: "k@l.co", orders: 2 },
    ]);
    await seedCheckout(testDb.db, autoStore, { token: "auto-1", email: "shopper@example.com", hoursAgo: 12 });

    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: new ScriptedProvider([
        {
          match: (request) => request.agentId === AiAgentId.RevenueRecovery,
          output: { drafts: [makeAgentDraft({ firingRef: "cart:auto-1", confidence: 88 })] },
        },
      ]),
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(autoStore, AiRunTrigger.Scheduled);
    expect(summary.executionsToEnqueue).toHaveLength(1);

    const rows = await withStoreScope(testDb.db, autoStore, async (tx) =>
      tx.select().from(recommendations).where(eq(recommendations.id, summary.created[0]!.id)),
    );
    expect(rows[0]!.status).toBe(RecommendationStatus.Approved);
    expect(rows[0]!.confidence).toBe(88);

    const executions = await withStoreScope(testDb.db, autoStore, async (tx) =>
      tx
        .select()
        .from(actionExecutions)
        .where(and(eq(actionExecutions.storeId, autoStore), eq(actionExecutions.status, "PENDING"))),
    );
    expect(executions).toHaveLength(1);

    const events = await withStoreScope(testDb.db, autoStore, async (tx) =>
      tx.select().from(recommendationEvents).where(eq(recommendationEvents.recommendationId, rows[0]!.id)),
    );
    expect(events.map((event) => event.event)).toEqual(["CREATED", "AUTO_APPROVED", "EXECUTION_QUEUED"]);
  });
});

describe("learning loop: recent rejection suppresses re-offers", () => {
  it("rejects, then re-runs within 30 days — no re-creation (reject memory)", async () => {
    const rejectStore = await seedStore(testDb.db, { shopDomain: "ai-reject.myshopify.com" });
    await seedAnalytics(testDb.db, rejectStore);
    await seedCheckout(testDb.db, rejectStore, { token: "rj-1", email: "later@example.com", hoursAgo: 10 });

    const provider = new ScriptedProvider([
      {
        match: (request) => request.agentId === AiAgentId.RevenueRecovery,
        output: { drafts: [makeAgentDraft({ firingRef: "cart:rj-1", confidence: 82 })] },
      },
    ]);
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const first = await service.run(rejectStore, AiRunTrigger.Scheduled);
    expect(first.created).toHaveLength(1);
    const recId = first.created[0]!.id;

    const recommendationsService = new RecommendationService(testDb.db);
    const userRows = await testDb.db
      .insert(users)
      .values({ email: "owner@reject.example", fullName: "Reject Owner", status: UserStatus.Active })
      .returning({ id: users.id });
    await recommendationsService.reject(rejectStore, recId, userRows[0]!.id, "Not our tone");

    const second = await service.run(rejectStore, AiRunTrigger.Scheduled);
    expect(second.created).toHaveLength(0);
    expect(second.duplicatesSkipped).toBe(1); // rejected <30d counts as a skip, not a re-offer

    const all = await withStoreScope(testDb.db, rejectStore, async (tx) =>
      tx.select().from(recommendations).where(eq(recommendations.storeId, rejectStore)),
    );
    expect(all).toHaveLength(1);
  });
});

describe("guardrails under agent failure", () => {
  it("a non-unavailability agent failure leaves the run COMPLETED with a recorded failure log", async () => {
    const partialStore = await seedStore(testDb.db, { shopDomain: "ai-partial.myshopify.com" });
    await seedAnalytics(testDb.db, partialStore);
    await seedCheckout(testDb.db, partialStore, { token: "pc-1", email: "partial@example.com", hoursAgo: 8 });
    // Win-back needs an inactive segment — give the store one so the second agent fires.
    await seedCustomers(testDb.db, partialStore, [
      { shopifyId: "w1", email: "w1@example.com", orders: 3, metrics: { orders: 3, spentCents: 30_000, lastOrderDaysAgo: 90 } },
      { shopifyId: "w2", email: "w2@example.com", orders: 2, metrics: { orders: 2, spentCents: 18_000, lastOrderDaysAgo: 75 } },
    ]);

    const provider = new ScriptedProvider([
      {
        match: (request) => request.agentId === AiAgentId.RevenueRecovery,
        output: { drafts: [makeAgentDraft({ firingRef: "cart:pc-1", confidence: 80 })] },
      },
      {
        match: (request) => request.agentId === AiAgentId.CustomerIntelligence,
        output: {},
        error: new AiProviderError("PROVIDER_ERROR", "schema mismatch", false),
      },
    ]);
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(partialStore, AiRunTrigger.Scheduled);
    expect(summary.status).toBe("COMPLETED"); // other agents still produced trustworthy output
    expect(summary.errorMessage).toContain("PROVIDER_ERROR");
    expect(summary.agentCalls).toBe(1); // failed calls are logged but do not consume the success budget
    expect(summary.created).toHaveLength(1);

    const logs = await withStoreScope(testDb.db, partialStore, async (tx) =>
      tx
        .select({ status: aiCallLogs.status, agentId: aiCallLogs.agentId })
        .from(aiCallLogs)
        .where(eq(aiCallLogs.storeId, partialStore)),
    );
    const statuses = logs.map((row) => `${row.agentId}:${row.status}`).sort();
    expect(statuses).toContain(`${AiAgentId.CustomerIntelligence}:FAILED`);
    expect(statuses).toContain(`${AiAgentId.RevenueRecovery}:SUCCEEDED`);
  });

  it("cost cap stops the fan-out cleanly (status stays COMPLETED, call budget respected)", async () => {
    const capStore = await seedStore(testDb.db, { shopDomain: "ai-cap.myshopify.com" });
    await seedAnalytics(testDb.db, capStore);
    await seedCheckout(testDb.db, capStore, { token: "cc-1", email: "cap@example.com", hoursAgo: 7 });
    await seedCustomers(testDb.db, capStore, [
      { shopifyId: "k1", email: "k1@example.com", orders: 4, metrics: { orders: 4, spentCents: 40_000, lastOrderDaysAgo: 100 } },
    ]);

    const provider = new ScriptedProvider([
      {
        match: (request) => request.agentId === AiAgentId.RevenueRecovery,
        output: { drafts: [makeAgentDraft({ firingRef: "cart:cc-1", confidence: 80 })] },
      },
      {
        match: (request) => request.agentId === AiAgentId.CustomerIntelligence,
        output: { drafts: [] },
      },
    ]);
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider,
      notifier,
      maxAgentCallsPerRun: 1, // one call only — the RevenueRecovery agent consumes the budget
    });
    const summary = await service.run(capStore, AiRunTrigger.Scheduled);
    expect(summary.status).toBe("COMPLETED");
    expect(summary.agentCalls).toBe(1);
    expect(provider.calls.map((call) => call.agentId)).toEqual([AiAgentId.RevenueRecovery]);
    expect(summary.created).toHaveLength(1);
    expect(summary.created[0]!.type).toBe(RecommendationType.RecoverAbandonedCart);
  });

  it("unavailability mid-run aborts the fan-out (no partial recommendation set)", async () => {
    const abortStore = await seedStore(testDb.db, { shopDomain: "ai-abort.myshopify.com" });
    await seedAnalytics(testDb.db, abortStore);
    await seedCheckout(testDb.db, abortStore, { token: "ab-1", email: "abort@example.com", hoursAgo: 6 });

    const provider = new ScriptedProvider([
      {
        match: () => true,
        output: {},
        error: new AiProviderError("RATE_LIMITED", "quota exhausted", true),
      },
    ]);
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(abortStore, AiRunTrigger.Scheduled);
    expect(summary.status).toBe("FAILED");
    expect(summary.created).toHaveLength(0);
    expect(summary.errorMessage).toContain("RATE_LIMITED");
    expect(provider.calls).toHaveLength(1); // aborted after the first failure — no lopsided fan-out
  });

  it("hallucinated firingRefs are dropped before they can reach the database (engine owns the keys)", async () => {
    const dropStore = await seedStore(testDb.db, { shopDomain: "ai-drops.myshopify.com" });
    await seedAnalytics(testDb.db, dropStore);
    await seedCheckout(testDb.db, dropStore, { token: "dr-1", email: "drops@example.com", hoursAgo: 9 });

    const provider = new ScriptedProvider([
      {
        match: () => true,
        output: {
          drafts: [
            makeAgentDraft({ firingRef: "cart:dr-1", confidence: 85 }), // real
            makeAgentDraft({ firingRef: "cart:made-up-999", confidence: 99, title: "Hallucinated cart" }), // invented
          ],
        },
      },
    ]);
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const summary = await service.run(dropStore, AiRunTrigger.Scheduled);
    expect(summary.status).toBe("COMPLETED");
    expect(summary.created).toHaveLength(1);
    expect(summary.created[0]!.title).not.toContain("Hallucinated");

    const rows = await withStoreScope(testDb.db, dropStore, async (tx) =>
      tx.select({ title: recommendations.title }).from(recommendations).where(eq(recommendations.storeId, dropStore)),
    );
    expect(rows).toHaveLength(1);
  });

  it("manual trigger notifies the merchant directly when the provider is unavailable", async () => {
    const manualStore = await seedStore(testDb.db, { shopDomain: "ai-manual.myshopify.com" });
    const before = notifyCalls.length;
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: null,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    await service.run(manualStore, AiRunTrigger.Manual);
    const fresh = notifyCalls.slice(before);
    expect(fresh.some((call) => call.title === "AI provider not configured")).toBe(true);
  });

  it("scheduled unavailability notify honours the 24h cooldown (no spam on retries)", async () => {
    const coolStore = await seedStore(testDb.db, { shopDomain: "ai-cool.myshopify.com" });
    const service = new DecisionService({
      db: testDb.db,
      logger,
      provider: null,
      notifier,
      maxAgentCallsPerRun: 5,
    });
    const before = notifyCalls.length;
    await service.run(coolStore, AiRunTrigger.Scheduled);
    await service.run(coolStore, AiRunTrigger.Scheduled); // second run within cooldown
    const fresh = notifyCalls.slice(before).filter((call) => call.title === "AI analysis is paused");
    expect(fresh).toHaveLength(1);
  });
});
