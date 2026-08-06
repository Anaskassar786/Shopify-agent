import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, billingEvents, eq, recommendations, subscriptions } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import {
  BillingEventType,
  PlanCode,
  RecommendationStatus,
  SubscriptionStatus,
} from "@profit/types";
import { BillingService } from "./billing.service";
import { TrialLifecycleService } from "./trial-lifecycle.service";
import {
  bootBillingTestDb,
  fakeMailer,
  seedBillingStore,
  seedSubscription,
  uniqueDomain,
} from "./test-support/integration";

const DAY = 24 * 3_600_000;
const ago = (ms: number): Date => new Date(Date.now() - ms);
const APP_URL = "https://app.profit.test";

let testDb: TestDatabase;

function lifecycle(mailer: ReturnType<typeof fakeMailer>["mailer"] | null) {
  return new TrialLifecycleService(testDb.db, new BillingService(testDb.db), mailer, APP_URL);
}

async function trialingStore(input: {
  tag: string;
  installedAgoMs: number;
  email?: string | null;
}): Promise<string> {
  const installedAt = ago(input.installedAgoMs);
  const storeId = await seedBillingStore(testDb.db, {
    shopDomain: uniqueDomain(input.tag),
    name: "Trial Store",
    email: input.email === undefined ? "owner@trial-store.example" : input.email,
    installedAt,
  });
  await seedSubscription(testDb.db, {
    storeId,
    planCode: PlanCode.Growth, // 3-day trial
    status: SubscriptionStatus.Trialing,
    trialEndsAt: new Date(installedAt.getTime() + 3 * DAY),
  });
  return storeId;
}

async function nudgeEvents(storeId: string) {
  return testDb.db
    .select()
    .from(billingEvents)
    .where(and(eq(billingEvents.storeId, storeId), eq(billingEvents.type, BillingEventType.TrialNudgeSent)));
}

async function openRecommendation(storeId: string, estimatedRevenueCents: number): Promise<void> {
  await testDb.db.insert(recommendations).values({
    storeId,
    fingerprint: createHash("sha256").update(randomUUID()).digest("hex"),
    type: "RECOVER_ABANDONED_CART",
    agentId: "REVENUE_RECOVERY",
    ruleId: "cart.abandoned-recovery",
    title: "Recover recent abandoned carts",
    description: "High-value carts went cold in the last 24 hours.",
    reasoning: ["point one", "point two"],
    priority: "HIGH",
    confidence: 84,
    riskLevel: "LOW",
    estimatedRevenueCents,
    estimatedCostCents: 960,
    subjects: { checkoutTokens: ["t"] },
    actionType: "SEND_RECOVERY_EMAIL",
    actionParams: {},
    status: RecommendationStatus.PendingApproval,
    expiresAt: new Date(Date.now() + 7 * DAY),
  });
}

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("D1–D3 journey nudges", () => {
  it("D1: waits 12h for real data, then sends once (ledger-deduped) with real numbers", async () => {
    const mailer = fakeMailer();
    const fresh = await trialingStore({ tag: "d1-fresh", installedAgoMs: 6 * 3_600_000 });
    const ready = await trialingStore({ tag: "d1-ready", installedAgoMs: 20 * 3_600_000 });
    await openRecommendation(ready, 12_000);
    await openRecommendation(ready, 8_400);

    const report = await lifecycle(mailer.mailer).tick();
    // The 6h-old store is not ready for D1; the 20h-old one is.
    expect(report.nudgesSent.some((nudge) => nudge.storeId === fresh)).toBe(false);
    const sent = report.nudgesSent.filter((nudge) => nudge.storeId === ready);
    expect(sent).toEqual([{ storeId: ready, day: 1, to: "owner@trial-store.example" }]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("Your store has 2 open opportunities");
    expect(mailer.sent[0]!.shopName).toBe("Trial Store");

    const marker = await nudgeEvents(ready);
    expect(marker).toHaveLength(1);
    expect((marker[0]!.metadata as Record<string, unknown>)["day"]).toBe(1);
    expect((marker[0]!.metadata as Record<string, unknown>)["openRecommendations"]).toBe(2);

    // Second tick: the ledger marker mutes the duplicate.
    const second = await lifecycle(mailer.mailer).tick();
    expect(second.nudgesSent.filter((nudge) => nudge.storeId === ready)).toHaveLength(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it("D2 quotes the deterministic recovery estimate", async () => {
    const mailer = fakeMailer();
    const storeId = await trialingStore({ tag: "d2", installedAgoMs: 26 * 3_600_000 });
    await openRecommendation(storeId, 76_800);
    const report = await lifecycle(mailer.mailer).tick();
    expect(report.nudgesSent).toEqual([{ storeId, day: 2, to: "owner@trial-store.example" }]);
    expect(mailer.sent[0]!.subject).toBe("AI found a potential $768.00 recovery opportunity");
    expect(mailer.sent[0]!.textBody).toContain(APP_URL);
  });

  it("D3 announces the ending trial", async () => {
    const mailer = fakeMailer();
    const storeId = await trialingStore({ tag: "d3", installedAgoMs: 50 * 3_600_000 });
    const report = await lifecycle(mailer.mailer).tick();
    expect(report.nudgesSent).toEqual([{ storeId, day: 3, to: "owner@trial-store.example" }]);
    expect(mailer.sent[0]!.subject).toBe("Trial Store: your free trial ends tomorrow");
  });

  it("without a mailer (or store email) it counts honestly and stay retryable", async () => {
    const noMailerStore = await trialingStore({ tag: "no-mailer", installedAgoMs: 20 * 3_600_000 });
    const noEmailStore = await trialingStore({ tag: "no-email", installedAgoMs: 20 * 3_600_000, email: null });

    const report = await lifecycle(null).tick();
    expect(report.nudgesSkippedNoMailer).toBeGreaterThanOrEqual(2);
    // No send attempt ⇒ no ledger marker ⇒ a later tick with a mailer retries.
    expect(await nudgeEvents(noMailerStore)).toHaveLength(0);

    const mailer = fakeMailer();
    const retry = await lifecycle(mailer.mailer).tick();
    const sent = retry.nudgesSent.map((nudge) => nudge.storeId);
    expect(sent).toContain(noMailerStore);
    expect(sent).not.toContain(noEmailStore); // null email stays skipped even with a mailer
  });
});

describe("expiry + suspension sweep", () => {
  it("flips TRIALING → TRIAL_EXPIRED at trialEndsAt and opens the grace window", async () => {
    const mailer = fakeMailer();
    const storeId = await trialingStore({ tag: "expiry", installedAgoMs: 4 * DAY }); // trial ended 1d ago
    const report = await lifecycle(mailer.mailer).tick();
    expect(report.trialsExpired).toContain(storeId);

    const rows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, storeId));
    expect(rows[0]!.status).toBe(SubscriptionStatus.TrialExpired);
    expect(rows[0]!.graceEndsAt).not.toBeNull();

    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.storeId, storeId), eq(billingEvents.type, BillingEventType.TrialExpired)));
    expect(events).toHaveLength(1);
  });

  it("flips TRIAL_EXPIRED/PAST_DUE → SUSPENDED once grace elapses", async () => {
    const mailer = fakeMailer();
    const expiredStore = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("suspend-1") });
    await seedSubscription(testDb.db, {
      storeId: expiredStore,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: ago(5 * DAY),
      graceEndsAt: ago(1 * DAY),
    });
    const pastDueStore = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("suspend-2") });
    await seedSubscription(testDb.db, {
      storeId: pastDueStore,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.PastDue,
      graceEndsAt: ago(2 * 3_600_000),
    });
    const stillInGrace = await seedBillingStore(testDb.db, { shopDomain: uniqueDomain("suspend-3") });
    await seedSubscription(testDb.db, {
      storeId: stillInGrace,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.TrialExpired,
      trialEndsAt: ago(1 * DAY),
      graceEndsAt: new Date(Date.now() + 1 * DAY),
    });

    const report = await lifecycle(mailer.mailer).tick();
    expect(report.suspended).toContain(expiredStore);
    expect(report.suspended).toContain(pastDueStore);
    expect(report.suspended).not.toContain(stillInGrace);

    const rows = await testDb.db.select().from(subscriptions).where(eq(subscriptions.storeId, expiredStore));
    expect(rows[0]!.status).toBe(SubscriptionStatus.Suspended);
    const events = await testDb.db
      .select()
      .from(billingEvents)
      .where(
        and(
          eq(billingEvents.storeId, expiredStore),
          eq(billingEvents.type, BillingEventType.SubscriptionSuspended),
        ),
      );
    expect(events).toHaveLength(1);
    expect((events[0]!.metadata as Record<string, unknown>)["reason"]).toBe("grace_elapsed");
  });
});
