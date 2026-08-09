import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  actionExecutions,
  aiCallLogs,
  backgroundJobs,
  billingEvents,
  engagementEvents,
  eq,
  and,
  notifications,
  recommendations,
  shopifySessions,
  stores,
  storeSettings,
  subscriptions,
  syncHistory,
  usageRecords,
} from "@profit/db";
import {
  BillingChurnScanTickJob,
  BillingReconcileTickJob,
  BillingTrialTickJob,
  BillingUsageRollupTickJob,
} from "@profit/billing";
import {
  AiNightlyTickJob,
  AiRunJob,
  AiExecuteEmailActionJob,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type EmailSender,
} from "@profit/ai";
import { SyncStoreFullJob } from "@profit/sync";
import {
  ActionType,
  AiAgentId,
  AiCallStatus,
  AiProviderId,
  AiRunTrigger,
  BillingInterval,
  EngagementEventKind,
  ExecutionStatus,
  ModelTier,
  PlanCode,
  RecommendationStatus,
  StoreStatus,
  SubscriptionStatus,
  UsageMeter,
} from "@profit/types";
import {
  buildWorkerTestEnvironment,
  jsonResponse,
  seedHarnessSubscription,
  WORKER_TEST_SHOP,
  type WorkerTestEnvironment,
} from "../test-support/harness";

/**
 * M5 billing/growth plane worker contracts, end-to-end through the REAL queue:
 * trial journey + expiry + suspension, convergent usage rollups, Shopify
 * charge reconcile, churn scan — plus the entitlement gates wired into the AI
 * pipeline (nightly-tick fan-out, email preflight) and the activation-funnel
 * milestone emits (FIRST_SYNC_COMPLETED / FIRST_AI_RUN_COMPLETED). Only the
 * outbound Shopify HTTP boundary is stubbed; the email sender is an injected
 * fake (identical discipline to the M4 AI suite).
 */

const DAY = 24 * 3_600_000;

class CaptureSender implements EmailSender {
  readonly sent: { to: string; subject: string }[] = [];
  async send(input: { to: string; subject: string; htmlBody: string; textBody: string }) {
    this.sent.push(input);
    return { messageId: `<b-${this.sent.length}>` };
  }
}

class QuietProvider implements AiProvider {
  readonly id = "GEMINI" as const;
  modelFor(_tier: ModelTier): string {
    return "stub-gemini";
  }
  async generate<TOutput>(request: AiGenerateRequest<TOutput>): Promise<AiGenerateResult<TOutput>> {
    const output = { drafts: [] } as TOutput;
    return {
      output,
      rawJson: JSON.stringify(output),
      model: "stub-gemini",
      usage: { inputTokens: 100, outputTokens: 20, costMicros: 10, latencyMs: 5 },
    };
  }
}

async function addStore(
  env: WorkerTestEnvironment,
  input: { domain: string; name: string; email?: string | null; installedAt?: Date },
): Promise<string> {
  const rows = await env.db
    .insert(stores)
    .values({
      shopDomain: input.domain,
      name: input.name,
      email: input.email ?? null,
      status: StoreStatus.Active,
      ...(input.installedAt !== undefined
        ? { installedAt: input.installedAt, createdAt: input.installedAt }
        : {}),
    })
    .returning({ id: stores.id });
  return rows[0]!.id;
}

async function addOfflineSession(env: WorkerTestEnvironment, storeId: string): Promise<void> {
  await env.db.insert(shopifySessions).values({
    storeId,
    sessionType: "OFFLINE",
    accessTokenEncrypted: env.deps.encryption.encrypt("fixture_reconcile_token"),
    scopes: ["read_products"],
  });
}

async function insertRecommendation(env: WorkerTestEnvironment, storeId: string): Promise<string> {
  const rows = await env.db
    .insert(recommendations)
    .values({
      storeId,
      fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
      type: "RECOVER_ABANDONED_CART",
      agentId: "REVENUE_RECOVERY",
      ruleId: "cart.abandoned-recovery",
      title: "Recover recent abandoned carts",
      description: "Carts went cold with high recovery odds.",
      reasoning: ["point one", "point two"],
      priority: "HIGH",
      confidence: 80,
      riskLevel: "LOW",
      estimatedRevenueCents: 1200,
      estimatedCostCents: 900,
      subjects: { checkoutTokens: ["t"] },
      actionType: "SEND_RECOVERY_EMAIL",
      actionParams: {},
      status: RecommendationStatus.Approved,
      expiresAt: new Date(Date.now() + 7 * DAY),
    })
    .returning({ id: recommendations.id });
  return rows[0]!.id;
}

describe("trial lifecycle tick via the queue", () => {
  let env: WorkerTestEnvironment;
  const sender = new CaptureSender();
  let storeD1: string;
  let storeExpiring: string;
  let storeSuspending: string;

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment({ emailSender: sender });
    const now = Date.now();

    // D1 candidate: 20h old, 2.2 trial days left → nudge day 1 (sent once).
    storeD1 = await addStore(env, {
      domain: "trial-d1.myshopify.com",
      name: "Trial D1",
      email: "d1@merch.test",
      installedAt: new Date(now - 20 * 3_600_000),
    });
    await seedHarnessSubscription(env.db, storeD1, {
      trialEndsAt: new Date(now + 2.2 * DAY),
    });

    // Expired trial: trialEndsAt in the past → TRIAL_EXPIRED + grace opens.
    storeExpiring = await addStore(env, {
      domain: "trial-expired.myshopify.com",
      name: "Trial Expired",
      email: "exp@merch.test",
      installedAt: new Date(now - 4 * DAY),
    });
    await seedHarnessSubscription(env.db, storeExpiring, {
      trialEndsAt: new Date(now - 3_600_000),
    });

    // Grace exhausted: already TRIAL_EXPIRED, graceEndsAt in the past → SUSPENDED.
    storeSuspending = await addStore(env, {
      domain: "trial-suspended.myshopify.com",
      name: "Trial Suspending",
      email: "susp@merch.test",
      installedAt: new Date(now - 9 * DAY),
    });
    await seedHarnessSubscription(env.db, storeSuspending, {
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: new Date(now - 3 * DAY),
      graceEndsAt: new Date(now - 3_600_000),
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it("sends the deduped D1 nudge, expires the trial, suspends the grace-exhausted store", async () => {
    await env.deps.persistence.enqueuePersistent(env.queue, BillingTrialTickJob, {}, {
      jobId: `billing:trial-tick:${randomUUID()}`,
    });
    await env.settle();

    // D1 nudge went out exactly once, to the right merchant, with real copy.
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("d1@merch.test");
    expect(sender.sent[0]!.subject).toBe("Your AI analysis is ready to explore");

    const d1Events = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeD1), eq(billingEvents.type, "TRIAL_NUDGE_SENT")));
    expect(d1Events).toHaveLength(1);
    expect((d1Events[0]!.metadata as { day: number }).day).toBe(1);

    // Expiry transition + ledger event.
    const expiring = (
      await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeExpiring))
    )[0]!;
    expect(expiring.status).toBe(SubscriptionStatus.TrialExpired);
    expect(expiring.graceEndsAt).not.toBeNull();
    expect(expiring.graceEndsAt!.getTime()).toBeGreaterThan(Date.now());
    const expiredEvents = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeExpiring), eq(billingEvents.type, "TRIAL_EXPIRED")));
    expect(expiredEvents).toHaveLength(1);

    // Grace exhaustion → suspension + ledger event.
    const suspended = (
      await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeSuspending))
    )[0]!;
    expect(suspended.status).toBe(SubscriptionStatus.Suspended);
    const suspendedEvents = await env.db
      .select()
      .from(billingEvents)
      .where(
        and(eq(billingEvents.storeId, storeSuspending), eq(billingEvents.type, "SUBSCRIPTION_SUSPENDED")),
      );
    expect(suspendedEvents).toHaveLength(1);

    // Re-run: the ledger dedupes the nudge — no double-send, no surprises.
    await env.deps.persistence.enqueuePersistent(env.queue, BillingTrialTickJob, {}, {
      jobId: `billing:trial-tick:${randomUUID()}`,
    });
    await env.settle();
    expect(sender.sent).toHaveLength(1);
  });
});

describe("usage rollup tick via the queue", () => {
  let env: WorkerTestEnvironment;

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment();
    // TRIALING: trial consumption is metered too (periodStart stays null).
    await seedHarnessSubscription(env.db, env.storeId);

    const now = new Date();
    const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterday = new Date(utcToday.getTime() - DAY + 3_600_000); // 01:00 UTC yesterday

    for (const cost of [100, 250]) {
      await env.db.insert(aiCallLogs).values({
        storeId: env.storeId,
        agentId: AiAgentId.BusinessAnalyst,
        provider: AiProviderId.Gemini,
        model: "gemini-2.5-flash",
        modelTier: ModelTier.Triage,
        promptId: "context.build",
        promptVersion: "1",
        status: AiCallStatus.Succeeded,
        inputTokens: 60,
        outputTokens: 40,
        costMicros: cost,
        latencyMs: 500,
        requestDigest: createHash("sha256").update(randomUUID()).digest("hex"),
        createdAt: yesterday,
        updatedAt: yesterday,
      });
    }

    const recId = await insertRecommendation(env, env.storeId);
    // One email execution with 2 recipients (metered per recipient, no startedAt).
    await env.db.insert(actionExecutions).values({
      storeId: env.storeId,
      recommendationId: recId,
      actionType: ActionType.SendRecoveryEmail,
      status: ExecutionStatus.Succeeded,
      idempotencyKey: createHash("sha256").update(randomUUID()).digest("hex"),
      actionPreview: {},
      toolRef: { sentTo: ["a@x.test", "b@x.test"] },
      createdAt: yesterday,
      updatedAt: yesterday,
      startedAt: null,
    });
    // Two automation runs (started executions).
    for (const actionType of [ActionType.CreateDiscountCode, ActionType.CreateDiscountCode] as const) {
      await env.db.insert(actionExecutions).values({
        storeId: env.storeId,
        recommendationId: recId,
        actionType,
        status: ExecutionStatus.Succeeded,
        idempotencyKey: createHash("sha256").update(randomUUID()).digest("hex"),
        actionPreview: {},
        toolRef: {},
        createdAt: yesterday,
        updatedAt: yesterday,
        startedAt: yesterday,
      });
    }
  });
  afterAll(async () => {
    await env.close();
  });

  it("rolls up ai/email/automation buckets; re-running converges to the same rows", async () => {
    await env.deps.persistence.enqueuePersistent(env.queue, BillingUsageRollupTickJob, {}, {
      jobId: `billing:usage-rollup:${randomUUID()}`,
    });
    await env.settle();

    const rows = await env.db.select().from(usageRecords).where(eq(usageRecords.storeId, env.storeId));
    expect(rows).toHaveLength(3);
    const byMeter = new Map(rows.map((row) => [row.meter, row]));
    expect(byMeter.get(UsageMeter.AiCalls)?.count).toBe(2);
    expect(byMeter.get(UsageMeter.AiCalls)?.costMicros).toBe(350);
    expect(byMeter.get(UsageMeter.EmailsSent)?.count).toBe(2);
    expect(byMeter.get(UsageMeter.AutomationRuns)?.count).toBe(2);
    // TRIALING buckets carry no paid-period stamp.
    expect(byMeter.get(UsageMeter.AiCalls)?.periodStart).toBeNull();

    // Idempotent by construction: the second tick rewrites the same buckets.
    await env.deps.persistence.enqueuePersistent(env.queue, BillingUsageRollupTickJob, {}, {
      jobId: `billing:usage-rollup:${randomUUID()}`,
    });
    await env.settle();
    const after = await env.db.select().from(usageRecords).where(eq(usageRecords.storeId, env.storeId));
    expect(after).toHaveLength(3);
    expect(new Map(after.map((row) => [row.meter, row])).get(UsageMeter.AiCalls)?.count).toBe(2);
  });
});

describe("charge reconcile tick via the queue", () => {
  let env: WorkerTestEnvironment;
  let storeAccepted: string;
  let storeDrift: string;

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment();
    const now = Date.now();

    // Pending charge the merchant accepted an hour ago (row created 2 days ago
    // so the reconcile poll engages — fresh rows get a day to decide).
    storeAccepted = await addStore(env, {
      domain: "reconcile-accepted.myshopify.com",
      name: "Reconcile Accepted",
      email: "acc@merch.test",
    });
    await addOfflineSession(env, storeAccepted);
    await seedHarnessSubscription(env.db, storeAccepted, {
      status: SubscriptionStatus.ChargePending,
      planCode: PlanCode.Growth,
      shopifyChargeId: "900101",
      billingInterval: BillingInterval.Monthly,
      trialEndsAt: new Date(now + DAY),
    });
    await env.db
      .update(subscriptions)
      .set({ updatedAt: new Date(now - 2 * DAY) })
      .where(eq(subscriptions.storeId, storeAccepted));

    // ACTIVE on our side, but the charge is gone from Shopify (merchant
    // cancelled inside Shopify Admin) → converge to CANCELLED.
    storeDrift = await addStore(env, {
      domain: "reconcile-drift.myshopify.com",
      name: "Reconcile Drift",
      email: "drift@merch.test",
    });
    await addOfflineSession(env, storeDrift);
    await seedHarnessSubscription(env.db, storeDrift, {
      status: SubscriptionStatus.Active,
      shopifyChargeId: "900202",
      billingInterval: BillingInterval.Monthly,
      currentPeriodStart: new Date(now - 10 * DAY),
      currentPeriodEnd: new Date(now + 20 * DAY),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("reconcile-accepted.myshopify.com")) {
          return jsonResponse({
            data: {
              currentAppInstallation: {
                activeSubscriptions: [
                  {
                    id: "gid://shopify/AppSubscription/900101",
                    name: "PROFIT TOOL AI — Growth (monthly)",
                    status: "ACTIVE",
                    test: true,
                  },
                ],
              },
            },
          });
        }
        if (url.includes("reconcile-drift.myshopify.com")) {
          return jsonResponse({ data: { currentAppInstallation: { activeSubscriptions: [] } } });
        }
        throw new Error(`unexpected fetch in reconcile test: ${url}`);
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env.close();
  });

  it("settles the accepted charge to ACTIVE and converges the vanished charge to CANCELLED", async () => {
    await env.deps.persistence.enqueuePersistent(env.queue, BillingReconcileTickJob, {}, {
      jobId: `billing:reconcile:${randomUUID()}`,
    });
    await env.settle();

    const accepted = (
      await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeAccepted))
    )[0]!;
    expect(accepted.status).toBe(SubscriptionStatus.Active);
    // Preserved trial day rides on top of the 30-day paid cycle.
    expect(accepted.currentPeriodStart).not.toBeNull();
    expect(accepted.currentPeriodEnd!.getTime() - accepted.currentPeriodStart!.getTime()).toBeGreaterThanOrEqual(
      31 * DAY,
    );
    const acceptedEvents = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeAccepted), eq(billingEvents.type, "CHARGE_ACCEPTED")));
    expect(acceptedEvents).toHaveLength(1);
    expect(acceptedEvents[0]!.chargeId).toBe("900101");

    const drift = (
      await env.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeDrift))
    )[0]!;
    expect(drift.status).toBe(SubscriptionStatus.Cancelled);
    const driftEvents = await env.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeDrift), eq(billingEvents.type, "CHARGE_RECONCILED")));
    expect(driftEvents).toHaveLength(1);
  });
});

describe("churn scan tick via the queue", () => {
  let env: WorkerTestEnvironment;
  const sender = new CaptureSender();

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment({ emailSender: sender });
    await env.db
      .update(stores)
      .set({ email: "owner@worker-store.test", installedAt: new Date(Date.now() - 30 * DAY) })
      .where(eq(stores.id, env.storeId));
    await seedHarnessSubscription(env.db, env.storeId);
    // Last real activity: the connect milestone, 6 days of silence since.
    const sixDaysAgo = new Date(Date.now() - 6 * DAY);
    await env.db.insert(engagementEvents).values({
      storeId: env.storeId,
      kind: EngagementEventKind.StoreConnected,
      metadata: { source: "oauth" },
      createdAt: sixDaysAgo,
      updatedAt: sixDaysAgo,
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it("nudges the disengaged store once; the 7-day cooldown mutes the re-run", async () => {
    await env.deps.persistence.enqueuePersistent(env.queue, BillingChurnScanTickJob, {}, {
      jobId: `billing:churn-scan:${randomUUID()}`,
    });
    await env.settle();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe("owner@worker-store.test");
    expect(sender.sent[0]!.subject).toContain("hasn't been reviewed in 6 days");

    const nudges = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(eq(engagementEvents.storeId, env.storeId), eq(engagementEvents.kind, "CHURN_NUDGE_SENT")),
      );
    expect(nudges).toHaveLength(1);

    await env.deps.persistence.enqueuePersistent(env.queue, BillingChurnScanTickJob, {}, {
      jobId: `billing:churn-scan:${randomUUID()}`,
    });
    await env.settle();
    expect(sender.sent).toHaveLength(1);
  });
});

describe("email execution entitlement preflight (expired store)", () => {
  let env: WorkerTestEnvironment;
  const sender = new CaptureSender();

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment({ emailSender: sender });
    // TRIAL_EXPIRED: revenue actions blocked until the merchant upgrades.
    await seedHarnessSubscription(env.db, env.storeId, {
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: new Date(Date.now() - DAY),
      graceEndsAt: new Date(Date.now() + DAY), // grace is irrelevant to the gate
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it("fails the execution terminally with upgrade copy — no retry, no email burned", async () => {
    const recId = await insertRecommendation(env, env.storeId);
    const executionId = (
      await env.db
        .insert(actionExecutions)
        .values({
          storeId: env.storeId,
          recommendationId: recId,
          actionType: ActionType.SendRecoveryEmail,
          status: ExecutionStatus.Pending,
          idempotencyKey: createHash("sha256").update(`${recId}|email|v1`).digest("hex"),
          actionPreview: {},
          toolRef: {},
        })
        .returning({ id: actionExecutions.id })
    )[0]!.id;

    await env.deps.persistence.enqueuePersistent(
      env.queue,
      AiExecuteEmailActionJob,
      { storeId: env.storeId, recommendationId: recId, executionId },
      { jobId: `aiexec:denied:${executionId}` },
    );
    await env.settle();

    const execution = (
      await env.db.select().from(actionExecutions).where(eq(actionExecutions.id, executionId))
    )[0]!;
    expect(execution.status).toBe(ExecutionStatus.Failed);
    expect(execution.errorMessage).toContain("Your subscription has expired. Upgrade to continue");

    const rec = (
      await env.db.select().from(recommendations).where(eq(recommendations.id, recId))
    )[0]!;
    expect(rec.status).toBe("FAILED");

    // Merchant hears about it; no quota was burned sending mail.
    const notes = await env.db
      .select()
      .from(notifications)
      .where(eq(notifications.storeId, env.storeId));
    expect(notes.some((n) => n.title === "An automation action failed")).toBe(true);
    expect(sender.sent).toHaveLength(0);
  });
});

describe("activation funnel milestones from the worker", () => {
  let env: WorkerTestEnvironment;

  beforeAll(async () => {
    env = await buildWorkerTestEnvironment({ aiProvider: new QuietProvider() });
    await seedHarnessSubscription(env.db, env.storeId);
    await env.db.insert(storeSettings).values({
      storeId: env.storeId,
      aiPreferences: {},
      automationPreferences: {},
      featureOverrides: {},
      branding: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          products: [],
          custom_collections: [],
          smart_collections: [],
          customers: [],
          orders: [],
          locations: [],
          inventory_levels: [],
          price_rules: [],
          metafields: [],
          checkouts: [],
          data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      ),
    );
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env.close();
  });

  it("a TRUE full sync emits FIRST_SYNC_COMPLETED exactly once", async () => {
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SyncStoreFullJob,
      { storeId: env.storeId },
      { jobId: `full:funnel:${randomUUID()}` },
    );
    await env.settle();

    const runs = await env.db.select().from(syncHistory).where(eq(syncHistory.storeId, env.storeId));
    expect(runs).toHaveLength(8); // every module of the true full run

    const milestones = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(
          eq(engagementEvents.storeId, env.storeId),
          eq(engagementEvents.kind, EngagementEventKind.FirstSyncCompleted),
        ),
      );
    expect(milestones).toHaveLength(1);

    // A second full run must NOT double-count the funnel step (partial unique index).
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      SyncStoreFullJob,
      { storeId: env.storeId },
      { jobId: `full:funnel-2:${randomUUID()}` },
    );
    await env.settle();
    const after = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(
          eq(engagementEvents.storeId, env.storeId),
          eq(engagementEvents.kind, EngagementEventKind.FirstSyncCompleted),
        ),
      );
    expect(after).toHaveLength(1);
  });

  it("a completed AI run emits FIRST_AI_RUN_COMPLETED; the nightly tick skips entitlement-blocked stores", async () => {
    await env.deps.persistence.enqueuePersistent(
      env.queue,
      AiRunJob,
      { storeId: env.storeId, trigger: AiRunTrigger.Manual },
      { jobId: `ai:funnel:${randomUUID()}` },
    );
    await env.settle();

    const milestones = await env.db
      .select()
      .from(engagementEvents)
      .where(
        and(
          eq(engagementEvents.storeId, env.storeId),
          eq(engagementEvents.kind, EngagementEventKind.FirstAiRunCompleted),
        ),
      );
    expect(milestones).toHaveLength(1);

    // Gate: a second Active store with an EXPIRED trial gets no scheduled run.
    const blockedStore = await addStore(env, {
      domain: "gate-blocked.myshopify.com",
      name: "Gate Blocked",
    });
    await seedHarnessSubscription(env.db, blockedStore, {
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: new Date(Date.now() - DAY),
      graceEndsAt: new Date(Date.now() - 3_600_000),
    });

    await env.deps.persistence.enqueuePersistent(env.queue, AiNightlyTickJob, {}, {
      jobId: `ai:tick:gate:${randomUUID()}`,
    });
    await env.settle();

    const runJobs = await env.db
      .select({ payload: backgroundJobs.payload, idempotencyKey: backgroundJobs.idempotencyKey })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.jobType, "ai.run"));
    const scheduledStoreIds = runJobs
      .filter((row) => row.idempotencyKey.startsWith("ai:run:"))
      .map((row) => (row.payload as { storeId: string }).storeId);
    expect(scheduledStoreIds).toContain(env.storeId);
    expect(scheduledStoreIds).not.toContain(blockedStore);
    // The harness stores are the only entitled ones — the tick sent exactly one run.
    expect(new Set(scheduledStoreIds).size).toBe(1);
  });
});
