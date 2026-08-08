import { eq } from "@profit/db";
import { platformFlags } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { PlatformFlagKey } from "@profit/types";
import { z } from "zod";

/**
 * Platform ops flags (launch readiness, ADR 37): maintenance mode lives as
 * ONE row in `platform_flags` (generic kv — future platform switches reuse
 * the same table, never a migration). Values are Zod-validated at the edge
 * of every read: a hand-edited row can never crash the guard, it just fails
 * closed to "not in maintenance" (the default state).
 *
 * Read path is OWNER-scoped by design (same trust class as the admin module):
 * `withStoreScope` would default-deny this no-tenant table BY DESIGN.
 */

const maintenanceValueSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(500).nullable(),
  setAt: z.string().min(1),
  setBy: z.string().min(1),
});

export type MaintenanceState = z.infer<typeof maintenanceValueSchema>;

export const DEFAULT_MAINTENANCE_MESSAGE =
  "PROFIT TOOL AI is temporarily paused for scheduled maintenance — back shortly. No data or pending work is lost.";

export class OpsFlagsService {
  private readonly db: ProfitDb;

  constructor(db: ProfitDb) {
    this.db = db;
  }

  /** Current maintenance state; null when never set (not in maintenance). */
  async getMaintenance(): Promise<MaintenanceState | null> {
    const rows = await this.db
      .select({ value: platformFlags.value })
      .from(platformFlags)
      .where(eq(platformFlags.key, PlatformFlagKey.Maintenance))
      .limit(1);
    const raw = rows[0]?.value;
    if (raw === undefined) return null;
    const parsed = maintenanceValueSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
  }

  /** Upsert the maintenance row (operator provenance recorded for the audit trail + UI truth). */
  async setMaintenance(input: {
    readonly enabled: boolean;
    readonly message: string | null;
    readonly setBy: string;
  }): Promise<MaintenanceState> {
    const value: MaintenanceState = {
      enabled: input.enabled,
      message: input.message,
      setAt: new Date().toISOString(),
      setBy: input.setBy,
    };
    await this.db
      .insert(platformFlags)
      .values({ key: PlatformFlagKey.Maintenance, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformFlags.key,
        set: { value, updatedAt: new Date() },
      });
    return value;
  }
}
