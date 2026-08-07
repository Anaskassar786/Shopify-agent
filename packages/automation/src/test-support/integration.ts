import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedPlatformCatalogs, shopifyCustomers, stores, storeSettings, users } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { PlanCode, StoreStatus, SubscriptionStatus, UserStatus } from "@profit/types";
import { plans, subscriptions } from "@profit/db";
import type { MessageEmailSender, MessageEmailSendInput, SmsSender, SmsSendInput, WorkflowAdminPort } from "../ports";

/**
 * Shared PGlite fixtures for the M6 suites — REAL migrations 0000→0007 (incl.
 * the automation/campaigns RLS block), owner-role seeding, exactly like the
 * billing/ai suites. Provider fakes own the external boundary (SMTP, Twilio,
 * Shopify Admin) so suites run hermetically; none of them is a mock in the
 * shipped code path.
 */

const here = dirname(fileURLToPath(import.meta.url));

export async function bootAutomationTestDb(): Promise<TestDatabase> {
  const testDb = await createTestDatabase(resolve(here, "../../../db/drizzle"));
  await seedPlatformCatalogs(testDb.db);
  return testDb;
}

export async function seedAutomationStore(
  db: ProfitDb,
  input: { shopDomain: string; name?: string; email?: string | null; timezone?: string },
): Promise<string> {
  const rows = await db
    .insert(stores)
    .values({
      shopDomain: input.shopDomain,
      name: input.name ?? "Automation Store",
      email: input.email ?? null,
      status: StoreStatus.Active,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
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

export async function seedActiveSubscription(db: ProfitDb, storeId: string): Promise<void> {
  const planRows = await db.select().from(plans);
  const plan = planRows.find((row) => row.code === PlanCode.Professional);
  if (plan === undefined) throw new Error("plans not seeded");
  await db.insert(subscriptions).values({
    storeId,
    planId: plan.id,
    status: SubscriptionStatus.Active,
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
  });
}

/** Seed a subscription against any plan/status (gate tests need specific quotas). */
export async function seedPlanSubscription(
  db: ProfitDb,
  input: {
    storeId: string;
    planCode: (typeof PlanCode)[keyof typeof PlanCode];
    status: (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];
  },
): Promise<void> {
  const planRows = await db.select().from(plans);
  const plan = planRows.find((row) => row.code === input.planCode);
  if (plan === undefined) throw new Error(`plan not seeded: ${input.planCode}`);
  await db.insert(subscriptions).values({
    storeId: input.storeId,
    planId: plan.id,
    status: input.status,
    currentPeriodStart: new Date(Date.now() - 86_400_000),
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    trialEndsAt: input.status === SubscriptionStatus.Trialing ? new Date(Date.now() + 86_400_000) : null,
  });
}

export async function seedUser(
  db: ProfitDb,
  input: { email: string; fullName?: string },
): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ email: input.email, fullName: input.fullName ?? "Test User", status: UserStatus.Active })
    .returning({ id: users.id });
  return rows[0]!.id;
}

export async function seedCustomer(
  db: ProfitDb,
  input: {
    storeId: string;
    shopifyCustomerId?: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    ordersCount?: number;
    totalSpent?: string;
    acceptsMarketing?: boolean;
    tags?: string[];
  },
): Promise<string> {
  const rows = await db
    .insert(shopifyCustomers)
    .values({
      storeId: input.storeId,
      shopifyCustomerId: input.shopifyCustomerId ?? randomUUID().slice(0, 12),
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      ordersCount: input.ordersCount ?? 0,
      totalSpent: input.totalSpent ?? "0",
      acceptsMarketing: input.acceptsMarketing ?? false,
      tags: input.tags ?? [],
    })
    .returning({ id: shopifyCustomers.id });
  return rows[0]!.id;
}

export interface FakeEmailSender {
  readonly sender: MessageEmailSender;
  readonly sent: MessageEmailSendInput[];
  failNext(error?: Error): void;
}

export function fakeEmailSender(): FakeEmailSender {
  const sent: MessageEmailSendInput[] = [];
  let nextError: Error | null = null;
  return {
    sent,
    failNext(error?: Error): void {
      nextError = error ?? new Error("smtp: connection reset");
    },
    sender: {
      async send(input: MessageEmailSendInput): Promise<{ messageId: string | null }> {
        if (nextError !== null) {
          const err = nextError;
          nextError = null;
          throw err;
        }
        sent.push(input);
        return { messageId: `msg-${sent.length}` };
      },
    },
  };
}

export interface FakeSmsSender {
  readonly sender: SmsSender;
  readonly sent: SmsSendInput[];
}

export function fakeSmsSender(): FakeSmsSender {
  const sent: SmsSendInput[] = [];
  return {
    sent,
    sender: {
      async send(input: SmsSendInput): Promise<{ providerRef: string | null }> {
        sent.push(input);
        return { providerRef: `SM-fake-${sent.length}` };
      },
    },
  };
}

export interface FakeAdminPort {
  readonly port: WorkflowAdminPort;
  readonly posts: { path: string; body: unknown }[];
  readonly puts: { path: string; body: unknown }[];
}

export function fakeAdminPort(): FakeAdminPort {
  const posts: { path: string; body: unknown }[] = [];
  const puts: { path: string; body: unknown }[] = [];
  return {
    posts,
    puts,
    port: {
      async postJson(path: string, body: unknown): Promise<unknown> {
        posts.push({ path, body });
        if (path.includes("price_rules.json") && !path.includes("discount_codes")) {
          return { price_rule: { id: 900001 } };
        }
        if (path.includes("discount_codes.json")) {
          const code = (body as { discount_code: { code: string } }).discount_code.code;
          return { discount_code: { id: 800001, code } };
        }
        return {};
      },
      async putJson(path: string, body: unknown): Promise<unknown> {
        puts.push({ path, body });
        return {};
      },
    },
  };
}

export function uniqueDomain(tag: string): string {
  return `${tag}-${randomUUID().slice(0, 8)}.myshopify.com`;
}
