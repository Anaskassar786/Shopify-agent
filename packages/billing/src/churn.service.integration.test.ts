import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engagementEvents, eq, sessions, users } from "@profit/db";
import type { TestDatabase } from "@profit/db/testing";
import { EngagementEventKind, PlanCode, SubscriptionStatus, UserStatus } from "@profit/types";
import {
  CHURN_INACTIVITY_DAYS,
  CHURN_NUDGE_COOLDOWN_DAYS,
  ChurnPreventionService,
} from "./churn.service";
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

function churn(mailer: ReturnType<typeof fakeMailer>["mailer"] | null) {
  return new ChurnPreventionService(testDb.db, mailer, APP_URL);
}

async function engagementAt(storeId: string, kind: EngagementEventKind, at: Date): Promise<void> {
  await testDb.db.insert(engagementEvents).values({
    storeId,
    kind,
    metadata: {},
    createdAt: at,
    updatedAt: at,
  });
}

async function quietStore(input: {
  tag: string;
  lastSeenAgoMs: number;
  email?: string | null;
  subscriptionStatus?: SubscriptionStatus;
}): Promise<string> {
  const storeId = await seedBillingStore(testDb.db, {
    shopDomain: uniqueDomain(input.tag),
    name: "Quiet Co",
    email: input.email === undefined ? "owner@quiet.example" : input.email,
  });
  if (input.subscriptionStatus !== undefined) {
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: input.subscriptionStatus,
    });
  }
  await engagementAt(storeId, EngagementEventKind.StoreConnected, ago(input.lastSeenAgoMs));
  return storeId;
}

const nudgesFor = async (storeId: string) =>
  testDb.db
    .select()
    .from(engagementEvents)
    .where(eq(engagementEvents.storeId, storeId));

beforeAll(async () => {
  testDb = await bootBillingTestDb();
});

afterAll(async () => {
  await testDb.close();
});

describe("disengagement detection", () => {
  it("nudges a silent store with an education email naming real silence length", async () => {
    const mailer = fakeMailer();
    const silent = await quietStore({
      tag: "silent",
      lastSeenAgoMs: (CHURN_INACTIVITY_DAYS + 2) * DAY, // 5 days quiet
      subscriptionStatus: SubscriptionStatus.Active,
    });
    const active = await quietStore({
      tag: "chatty",
      lastSeenAgoMs: 12 * 3_600_000, // 12h — engaged
      subscriptionStatus: SubscriptionStatus.Active,
    });

    const report = await churn(mailer.mailer).tick();
    expect(report.nudged).toEqual([{ storeId: silent, to: "owner@quiet.example" }]);
    expect(report.nudged.some((row) => row.storeId === active)).toBe(false);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("Quiet Co: your store hasn't been reviewed in 5 days");
    expect(mailer.sent[0]!.textBody).toContain("store connected");
    expect(mailer.sent[0]!.textBody).toContain(APP_URL);

    // The nudge itself landed in the engagement stream (cooldown bookkeeping).
    const rows = await nudgesFor(silent);
    const nudgeRow = rows.find((row) => row.kind === EngagementEventKind.ChurnNudgeSent);
    expect(nudgeRow).toBeDefined();
    expect((nudgeRow!.metadata as Record<string, unknown>)["silentDays"]).toBe(5);
  });

  it("honors the cooldown window exactly once per 7 days", async () => {
    expect(CHURN_NUDGE_COOLDOWN_DAYS).toBe(7);
    const mailer = fakeMailer();
    const storeId = await quietStore({
      tag: "cooldown",
      lastSeenAgoMs: 8 * DAY,
      subscriptionStatus: SubscriptionStatus.Trialing,
    });
    // A nudge already went out 5 days ago (inside the cooldown).
    await engagementAt(storeId, EngagementEventKind.ChurnNudgeSent, ago(5 * DAY));

    const report = await churn(mailer.mailer).tick();
    expect(report.candidates).toBeGreaterThanOrEqual(1);
    expect(report.nudged.some((row) => row.storeId === storeId)).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("never nudges suspended/cancelled/expired subscriptions — that is a billing conversation", async () => {
    const mailer = fakeMailer();
    const suspended = await quietStore({
      tag: "churn-suspended",
      lastSeenAgoMs: 6 * DAY,
      subscriptionStatus: SubscriptionStatus.Suspended,
    });
    const cancelled = await quietStore({
      tag: "churn-cancelled",
      lastSeenAgoMs: 6 * DAY,
      subscriptionStatus: SubscriptionStatus.Cancelled,
    });
    const report = await churn(mailer.mailer).tick();
    expect(report.nudged.some((row) => row.storeId === suspended)).toBe(false);
    expect(report.nudged.some((row) => row.storeId === cancelled)).toBe(false);
    const rows = await nudgesFor(suspended);
    expect(rows.some((row) => row.kind === EngagementEventKind.ChurnNudgeSent)).toBe(false);
  });

  it("counts mailer-missing skips honestly", async () => {
    const storeId = await quietStore({
      tag: "churn-nomailer",
      lastSeenAgoMs: 6 * DAY,
      subscriptionStatus: SubscriptionStatus.Trialing,
    });
    const report = await churn(null).tick();
    expect(report.skippedNoMailer).toBeGreaterThanOrEqual(1);
    expect(report.nudged.some((row) => row.storeId === storeId)).toBe(false);
    // no send ⇒ no ChurnNudgeSent row ⇒ the next configured tick will retry
    const rows = await nudgesFor(storeId);
    expect(rows.some((row) => row.kind === EngagementEventKind.ChurnNudgeSent)).toBe(false);
  });
});

describe("session activity fold (M5 amendment — P11 'no logins' signal)", () => {
  async function loginSessionAt(storeId: string, at: Date): Promise<void> {
    const userRows = await testDb.db
      .insert(users)
      .values({
        email: `merchant-${storeId.slice(0, 8)}@example.test`,
        fullName: "Session Merchant",
        status: UserStatus.Active,
      })
      .returning();
    await testDb.db.insert(sessions).values({
      userId: userRows[0]!.id,
      storeId,
      expiresAt: new Date(at.getTime() + 12 * 3_600_000),
      createdAt: at,
      updatedAt: at,
    });
  }

  it("a recent login resets the churn clock even without funnel events", async () => {
    const mailer = fakeMailer();
    const loggedIn = await quietStore({
      tag: "sessional",
      lastSeenAgoMs: 6 * DAY, // quiet funnel…
      subscriptionStatus: SubscriptionStatus.Active,
    });
    await loginSessionAt(loggedIn, ago(10 * 3_600_000)); // …but logged in 10h ago
    const report = await churn(mailer.mailer).tick();
    expect(report.nudged.some((row) => row.storeId === loggedIn)).toBe(false);
  });

  it("a never-engaged store's lastSeen comes from sessions alone", async () => {
    const mailer = fakeMailer();
    const storeId = await seedBillingStore(testDb.db, {
      shopDomain: uniqueDomain("session-only"),
      name: "Quiet Co",
      email: "owner@session-only.example",
    });
    await seedSubscription(testDb.db, {
      storeId,
      planCode: PlanCode.Growth,
      status: SubscriptionStatus.Active,
    });
    await loginSessionAt(storeId, ago(10 * DAY)); // 10 days since the last login — no events at all
    const report = await churn(mailer.mailer).tick();
    expect(report.nudged).toContainEqual({ storeId, to: "owner@session-only.example" });
    const email = mailer.sent.find((sent) => sent.to === "owner@session-only.example");
    expect(email!.subject).toContain("10 days");
  });
});
