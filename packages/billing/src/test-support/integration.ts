import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  plans,
  seedPlatformCatalogs,
  stores,
  storeSettings,
  subscriptions,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { PlanCode, StoreStatus, SubscriptionStatus } from "@profit/types";
import type {
  BillingChargeProvider,
  LiveSubscription,
  RecurringChargeRequest,
  RecurringChargeResult,
  SubscriptionStatusUpdate,
  TransactionalEmail,
  TrialMailer,
} from "../ports";

/**
 * Shared PGlite fixtures for the billing/growth-plane suites — REAL migrations
 * 0000→0006 (incl. the M5 RLS block + partial milestone index), owner-role
 * seeding, exactly like the ai/notifications suites.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Fresh PGlite with platform catalogs (plans) seeded — subscriptions FK to plans. */
export async function bootBillingTestDb(): Promise<TestDatabase> {
  const testDb = await createTestDatabase(resolve(here, "../../../db/drizzle"));
  await seedPlatformCatalogs(testDb.db);
  return testDb;
}

export async function seedBillingStore(
  db: ProfitDb,
  input: {
    shopDomain: string;
    name?: string;
    email?: string | null;
    installedAt?: Date;
    status?: StoreStatus;
  },
): Promise<string> {
  const rows = await db
    .insert(stores)
    .values({
      shopDomain: input.shopDomain,
      name: input.name ?? "Billing Store",
      email: input.email ?? null,
      status: input.status ?? StoreStatus.Active,
      ...(input.installedAt !== undefined ? { installedAt: input.installedAt } : {}),
    })
    .returning();
  const id = rows[0]!.id;
  await db.insert(storeSettings).values({
    storeId: id,
    aiPreferences: {},
    automationPreferences: {},
    featureOverrides: {},
    branding: {},
  });
  return id;
}

export async function planIdFor(db: ProfitDb, code: PlanCode): Promise<string> {
  const rows = await db.select().from(plans);
  const plan = rows.find((row) => row.code === code);
  if (plan === undefined) throw new Error(`plan not seeded: ${code}`);
  return plan.id;
}

/** Direct subscription row seed (bypasses the service so tests control every timestamp). */
export async function seedSubscription(
  db: ProfitDb,
  input: {
    storeId: string;
    planCode: PlanCode;
    status: SubscriptionStatus;
    shopifyChargeId?: string | null;
    billingInterval?: "MONTHLY" | "YEARLY" | null;
    trialEndsAt?: Date | null;
    graceEndsAt?: Date | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelledAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Promise<string> {
  const planRows = await db.select().from(plans);
  const plan = planRows.find((row) => row.code === input.planCode);
  if (plan === undefined) throw new Error(`plan not seeded: ${input.planCode}`);
  const rows = await db
    .insert(subscriptions)
    .values({
      storeId: input.storeId,
      planId: plan.id,
      status: input.status,
      shopifyChargeId: input.shopifyChargeId ?? null,
      billingInterval: input.billingInterval ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
      graceEndsAt: input.graceEndsAt ?? null,
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelledAt: input.cancelledAt ?? null,
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    })
    .returning({ id: subscriptions.id });
  return rows[0]!.id;
}

export interface FakeChargeProvider {
  readonly provider: BillingChargeProvider;
  /** createRecurringCharge requests, in order. */
  readonly createRequests: RecurringChargeRequest[];
  /** cancelRecurringCharge charge ids, in order. */
  readonly cancelRequests: string[];
  /** Replace the live-subscription list between calls. */
  setLive(live: readonly LiveSubscription[]): void;
}

/** Recording provider fake — drives charge flows without Shopify (tests own the boundary). */
export function fakeChargeProvider(input?: {
  live?: readonly LiveSubscription[];
  chargeId?: string;
  confirmationUrl?: string;
}): FakeChargeProvider {
  let live = input?.live ?? [];
  const createRequests: RecurringChargeRequest[] = [];
  const cancelRequests: string[] = [];
  let seq = 0;
  const provider: BillingChargeProvider = {
    createRecurringCharge(request: RecurringChargeRequest): Promise<RecurringChargeResult> {
      createRequests.push(request);
      seq += 1;
      return Promise.resolve({
        chargeId: input?.chargeId ?? `CHG-${String(seq).padStart(4, "0")}`,
        confirmationUrl: input?.confirmationUrl ?? "https://demo-store.myshopify.com/admin/charges/confirm",
      });
    },
    cancelRecurringCharge(chargeId: string): Promise<SubscriptionStatusUpdate> {
      cancelRequests.push(chargeId);
      return Promise.resolve({ chargeId, status: "CANCELLED" });
    },
    fetchLiveSubscriptions(): Promise<readonly LiveSubscription[]> {
      return Promise.resolve(live);
    },
  };
  return {
    provider,
    createRequests,
    cancelRequests,
    setLive(next) {
      live = next;
    },
  };
}

export interface FakeMailer {
  readonly mailer: TrialMailer;
  readonly sent: TransactionalEmail[];
}

export function fakeMailer(): FakeMailer {
  const sent: TransactionalEmail[] = [];
  return {
    sent,
    mailer: {
      send(email: TransactionalEmail): Promise<void> {
        sent.push(email);
        return Promise.resolve();
      },
    },
  };
}

/** Deterministic-ish unique domain for stores inside one suite. */
export function uniqueDomain(tag: string): string {
  return `${tag}-${randomUUID().slice(0, 8)}.myshopify.com`;
}
