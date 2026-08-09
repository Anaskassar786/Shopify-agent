import { z } from "zod";
import { ReportKind, type ReportKind as ReportKindValue } from "@profit/types";
import { closedPeriodFor, periodIsoRange } from "./periods";

/**
 * Report preferences (ADR 34): the schedule lives in store_settings.json —
 *  the cadence is data (4 booleans + delivery), not a scheduling table. Due
 *  detection is convergent: a kind is due when no report row exists for its
 *  current closed period, so a crashed tick simply retries next round.
 */

export const reportPreferencesSchema = z
  .object({
    kinds: z
      .object({
        DAILY: z.boolean(),
        WEEKLY: z.boolean(),
        MONTHLY: z.boolean(),
        QUARTERLY: z.boolean(),
      })
      .partial(),
    emailDelivery: z.boolean(),
    /** Defaults to the store contact email when absent. */
    recipientEmail: z.string().email().max(320).nullish(),
  })
  .partial();

export type ReportPreferencesInput = z.infer<typeof reportPreferencesSchema>;

export interface ReportPreferences {
  readonly kinds: Readonly<Record<ReportKindValue, boolean>>;
  readonly emailDelivery: boolean;
  readonly recipientEmail: string | null;
}

export const DEFAULT_REPORT_PREFERENCES: ReportPreferences = {
  kinds: {
    [ReportKind.Daily]: false,
    [ReportKind.Weekly]: true,
    [ReportKind.Monthly]: true,
    [ReportKind.Quarterly]: false,
  },
  emailDelivery: false,
  recipientEmail: null,
};

/** Parse the settings jsonb against defaults — unknown values never crash. */
export function parseReportPreferences(raw: unknown): ReportPreferences {
  const parsed = reportPreferencesSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : {};
  return {
    kinds: {
      [ReportKind.Daily]: value.kinds?.DAILY ?? DEFAULT_REPORT_PREFERENCES.kinds[ReportKind.Daily],
      [ReportKind.Weekly]: value.kinds?.WEEKLY ?? DEFAULT_REPORT_PREFERENCES.kinds[ReportKind.Weekly],
      [ReportKind.Monthly]: value.kinds?.MONTHLY ?? DEFAULT_REPORT_PREFERENCES.kinds[ReportKind.Monthly],
      [ReportKind.Quarterly]: value.kinds?.QUARTERLY ?? DEFAULT_REPORT_PREFERENCES.kinds[ReportKind.Quarterly],
    },
    emailDelivery: value.emailDelivery ?? DEFAULT_REPORT_PREFERENCES.emailDelivery,
    recipientEmail: value.recipientEmail ?? null,
  };
}

export interface ExistingReportPointer {
  readonly kind: ReportKindValue;
  readonly periodStartIso: string;
}

/**
 * Which enabled kinds are due at `now`, given the latest existing period per
 * kind. A kind with NO history is due immediately (first report lands on the
 * next tick after enabling — honest product behavior, documented).
 */
export function dueKinds(
  preferences: ReportPreferences,
  existing: readonly ExistingReportPointer[],
  now: Date,
): ReportKindValue[] {
  const due: ReportKindValue[] = [];
  for (const kind of Object.values(ReportKind)) {
    if (!preferences.kinds[kind]) continue;
    const period = closedPeriodFor(kind, now);
    const { from } = periodIsoRange(period);
    const exists = existing.some((pointer) => pointer.kind === kind && pointer.periodStartIso === from);
    if (!exists) due.push(kind);
  }
  return due;
}
