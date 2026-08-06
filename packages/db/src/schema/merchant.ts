import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { BillingInterval, PlanCode, StoreStatus, SubscriptionStatus } from "@profit/types";
import { baseColumns, enumToPgTuple, softDeleteColumns } from "./_common";

export const storeStatusEnum = pgEnum("store_status", enumToPgTuple(StoreStatus));
export const planCodeEnum = pgEnum("plan_code", enumToPgTuple(PlanCode));
export const subscriptionStatusEnum = pgEnum(
  "subscription_status",
  enumToPgTuple(SubscriptionStatus),
);
/** M5: charge cadence chosen at subscribe time (interval switching = new charge). */
export const billingIntervalEnum = pgEnum("billing_interval", enumToPgTuple(BillingInterval));

/**
 * Tenant root. One row per connected Shopify store. `stores` is the documented
 * exception to the store_id rule: it IS the tenant.
 */
export const stores = pgTable(
  "stores",
  {
    ...baseColumns,
    ...softDeleteColumns,
    /** Canonical {shop}.myshopify.com domain — immutable; used for webhook↔store resolution. */
    shopDomain: varchar("shop_domain", { length: 255 }).notNull(),
    /** Numeric shop id from Shopify, kept for cross-checks and support. */
    shopifyShopId: varchar("shopify_shop_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    status: storeStatusEnum("status").notNull().default("ACTIVE"),
    installedAt: timestamp("installed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    uninstalledAt: timestamp("uninstalled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("stores_shop_domain_unique").on(table.shopDomain),
    index("stores_status_idx").on(table.status),
  ],
);

/** 1:1 with stores — merchant-editable configuration, JSON-shaped for forward-compatible evolution. */
export const storeSettings = pgTable(
  "store_settings",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    /** { logoUrl?, primaryColor?, ... } — embedded UI theming (P4). */
    branding: jsonb("branding").notNull().default(sql`'{}'::jsonb`),
    /** { goals: string[], autonomyMode, modelTierOverrides? } — default agent config (P7). */
    aiPreferences: jsonb("ai_preferences").notNull().default(sql`'{}'::jsonb`),
    /** { mode, quietHours?, approvalPolicy } — automation defaults (P3). */
    automationPreferences: jsonb("automation_preferences")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Per-merchant feature-flag overrides layered over platform flags (P5). */
    featureOverrides: jsonb("feature_overrides")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Set when the merchant finishes the onboarding wizard (P4 flow). */
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [uniqueIndex("store_settings_store_unique").on(table.storeId)],
);

/**
 * Platform pricing catalog (documented store_id exception).
 * Entitlements are JSON capabilities+quotas so pricing changes never require deploys (P11).
 */
export const plans = pgTable(
  "plans",
  {
    ...baseColumns,
    code: planCodeEnum("code").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }),
    monthlyPriceCents: integer("monthly_price_cents").notNull(),
    yearlyPriceCents: integer("yearly_price_cents").notNull(),
    trialDays: integer("trial_days").notNull().default(3),
    /** { capabilities: string[], quotas: { aiCalls, emails, sms, automationRuns, seats, stores } } */
    entitlements: jsonb("entitlements").notNull().default(sql`'{}'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [uniqueIndex("plans_code_unique").on(table.code)],
);

/** Subscription lifecycle per store (P2/P7). Shopify charge id is the payment source of truth. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    ...baseColumns,
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: subscriptionStatusEnum("status").notNull().default("TRIALING"),
    /** Shopify Billing recurring charge id. */
    shopifyChargeId: varchar("shopify_charge_id", { length: 64 }),
    /** M5: cadence of the active/pending charge (null while on trial). */
    billingInterval: billingIntervalEnum("billing_interval"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "date" }),
    /**
     * M5 grace: after TRIAL_EXPIRED (or a vanished charge) revenue actions stay
     * readable-blocked but the store is not SUSPENDED until this instant passes.
     */
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true, mode: "date" }),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "date",
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "date",
    }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("subscriptions_store_status_idx").on(table.storeId, table.status),
  ],
);
