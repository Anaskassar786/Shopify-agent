import { sql } from "drizzle-orm";
import { PlanCode, UserRole } from "@profit/types";
import type { ProfitDb } from "./client";
import { permissions, plans, rolePermissions, roles } from "./schema/index";

/**
 * Idempotent seed for platform catalogs (roles/permissions/plans). These are
 * platform (non-tenant) tables, so the owner connection seeds them directly.
 * Re-running is a safe no-op (upserts on unique codes). M1+ deployment runbook
 * Step M-1: `pnpm run db:seed` after every migrate (P6 checklist).
 */

export const PERMISSION_CODES = [
  "store:read",
  "store:update",
  "settings:update",
  "products:read",
  "products:sync",
  "customers:read",
  "customers:sync",
  "orders:read",
  "orders:sync",
  "inventory:read",
  "inventory:sync",
  "checkouts:sync",
  "collections:sync",
  "discounts:sync",
  "metafields:sync",
  "analytics:read",
  "recommendations:read",
  "recommendations:approve",
  "recommendations:reject",
  "automation:read",
  "automation:manage",
  "notifications:read",
  "notifications:update",
  "billing:read",
  "billing:manage",
  "audit:read",
  "users:read",
  "users:manage",
  "apikeys:manage",
  // M6: campaigns, support tickets, exports
  "campaigns:read",
  "campaigns:manage",
  "support:read",
  "support:manage",
  "exports:read",
  "exports:manage",
] as const;
export type PermissionCode = (typeof PERMISSION_CODES)[number];

const ROLE_MATRIX: Readonly<Record<UserRole, readonly PermissionCode[]>> = {
  OWNER: PERMISSION_CODES,
  ADMIN: PERMISSION_CODES,
  MANAGER: [
    "store:read",
    "products:read",
    "products:sync",
    "customers:read",
    "customers:sync",
    "orders:read",
    "orders:sync",
    "inventory:read",
    "inventory:sync",
    "checkouts:sync",
    "collections:sync",
    "discounts:sync",
    "metafields:sync",
    "analytics:read",
    "recommendations:read",
    "recommendations:approve",
    "recommendations:reject",
    "automation:read",
    "automation:manage",
    "notifications:read",
    "notifications:update",
    "billing:read",
    "audit:read",
    "users:read",
    "campaigns:read",
    "campaigns:manage",
    "support:read",
    "support:manage",
    "exports:read",
    "exports:manage",
  ],
  STAFF: [
    "store:read",
    "products:read",
    "customers:read",
    "orders:read",
    "inventory:read",
    "analytics:read",
    "recommendations:read",
    "notifications:read",
    "notifications:update",
    "support:read",
    "support:manage",
    "exports:read",
  ],
  ANALYST: [
    "store:read",
    "products:read",
    "customers:read",
    "orders:read",
    "inventory:read",
    "analytics:read",
    "recommendations:read",
    "audit:read",
    "campaigns:read",
    "exports:read",
    "exports:manage",
    "support:read",
    "support:manage",
  ],
  SUPPORT: [
    "store:read",
    "customers:read",
    "orders:read",
    "audit:read",
    "support:read",
    "support:manage",
  ],
  VIEWER: [
    "store:read",
    "analytics:read",
    "recommendations:read",
    "notifications:read",
    "support:read",
    "support:manage",
  ],
};

interface PlanSeed {
  code: (typeof PlanCode)[keyof typeof PlanCode];
  name: string;
  description: string;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  trialDays: number;
  entitlements: { capabilities: string[]; quotas: Record<string, number> };
}

/** Pricing from PART 11 example ranges (conservative within each band). */
const PLAN_SEEDS: readonly PlanSeed[] = [
  {
    code: "STARTER",
    name: "Starter",
    description: "Core dashboard, basic analytics and AI recommendations for small stores.",
    monthlyPriceCents: 2900,
    yearlyPriceCents: 29_000,
    trialDays: 3,
    entitlements: {
      capabilities: ["dashboard", "basic_analytics", "ai_recommendations", "customer_insights"],
      quotas: { aiCalls: 100, emails: 500, sms: 0, automationRuns: 20, seats: 1, stores: 1 },
    },
  },
  {
    code: "GROWTH",
    name: "Growth",
    description: "Unlimited recommendations, automation workflows, email recovery and segmentation.",
    monthlyPriceCents: 7900,
    yearlyPriceCents: 79_000,
    trialDays: 3,
    entitlements: {
      capabilities: [
        "dashboard",
        "advanced_analytics",
        "ai_recommendations_unlimited",
        "automation",
        "email_campaigns",
        "customer_segmentation",
      ],
      quotas: { aiCalls: 2000, emails: 10_000, sms: 0, automationRuns: 1000, seats: 3, stores: 1 },
    },
  },
  {
    code: "PROFESSIONAL",
    name: "Professional",
    description: "Predictive analytics, discount intelligence, inventory AI, multiple users.",
    monthlyPriceCents: 24900,
    yearlyPriceCents: 249_000,
    trialDays: 3,
    entitlements: {
      capabilities: [
        "dashboard",
        "predictive_analytics",
        "ai_recommendations_unlimited",
        "automation",
        "email_campaigns",
        "sms_campaigns",
        "customer_segmentation",
        "discount_intelligence",
        "inventory_ai",
        "priority_support",
      ],
      quotas: { aiCalls: 10_000, emails: 50_000, sms: 2000, automationRuns: 10_000, seats: 10, stores: 1 },
    },
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    description: "Multiple stores, custom AI agents, API access, SLA and dedicated support.",
    monthlyPriceCents: 99900,
    yearlyPriceCents: 999_000,
    trialDays: 14,
    entitlements: {
      capabilities: [
        "dashboard",
        "predictive_analytics",
        "ai_recommendations_unlimited",
        "automation",
        "email_campaigns",
        "sms_campaigns",
        "customer_segmentation",
        "discount_intelligence",
        "inventory_ai",
        "multi_store",
        "custom_ai_agents",
        "api_access",
        "sla",
        "dedicated_support",
      ],
      quotas: { aiCalls: 100_000, emails: 500_000, sms: 20_000, automationRuns: 100_000, seats: 100, stores: 25 },
    },
  },
];

export async function seedPlatformCatalogs(db: ProfitDb): Promise<{
  roles: number;
  permissions: number;
  rolePermissions: number;
  plans: number;
}> {
  const permissionRows = PERMISSION_CODES.map((code) => ({
    code,
    description: code.replace(":", " — ").replaceAll("_", " "),
  }));
  await db
    .insert(permissions)
    .values(permissionRows)
    .onConflictDoNothing({ target: permissions.code });

  const roleRows = Object.values(UserRole).map((code) => ({
    code,
    name: code.charAt(0) + code.slice(1).toLowerCase(),
    description: `${code} role (seeded catalog)`,
  }));
  await db.insert(roles).values(roleRows).onConflictDoNothing({ target: roles.code });

  // Rebuild the role→permission matrix deterministically (catalog is code-owned).
  const allRoles = await db.select().from(roles);
  const allPermissions = await db.select().from(permissions);
  const permissionIdByCode = new Map(allPermissions.map((p) => [p.code, p.id]));

  await db.execute(sql`DELETE FROM role_permissions`);
  const links: { roleId: string; permissionId: string }[] = [];
  for (const role of allRoles) {
    const grant = ROLE_MATRIX[role.code as UserRole];
    if (!grant) continue;
    for (const code of grant) {
      const permissionId = permissionIdByCode.get(code);
      if (permissionId !== undefined) links.push({ roleId: role.id, permissionId });
    }
  }
  if (links.length > 0) {
    await db.insert(rolePermissions).values(links).onConflictDoNothing();
  }

  let plansUpserted = 0;
  for (const plan of PLAN_SEEDS) {
    await db
      .insert(plans)
      .values({ ...plan, isActive: true })
      .onConflictDoUpdate({
        target: plans.code,
        set: {
          name: plan.name,
          description: plan.description,
          monthlyPriceCents: plan.monthlyPriceCents,
          yearlyPriceCents: plan.yearlyPriceCents,
          trialDays: plan.trialDays,
          entitlements: plan.entitlements,
          isActive: true,
          updatedAt: new Date(),
        },
      });
    plansUpserted += 1;
  }

  return {
    roles: roleRows.length,
    permissions: permissionRows.length,
    rolePermissions: links.length,
    plans: plansUpserted,
  };
}
