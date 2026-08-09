import { and, desc, eq, gte, type ProfitDb } from "@profit/db";
import {
  notifications,
  reports,
  stores,
  storeSettings,
  withStoreScope,
} from "@profit/db";
import {
  composeExecutiveSummary,
  type AiProvider,
  type EmailSender,
} from "@profit/ai";
import { ForecastService } from "@profit/forecasting";
import {
  NotificationCategory,
  ReportStatus,
  type ReportKind as ReportKindValue,
  type ReportStatus as ReportStatusValue,
} from "@profit/types";
import type { Logger } from "@profit/logger";
import { renderReportEmail } from "./email";
import { buildReportPdf, reportFilename } from "./pdf";
import { closedPeriodFor, periodLabel, type ReportPeriod } from "./periods";
import { dueKinds, parseReportPreferences, type ReportPreferences } from "./preferences";
import { buildReportSections, type ReportSectionsData } from "./sections";

/**
 * Enterprise report service (M8, ADR 34): convergent generation per
 * (store, kind, period) guarded by the unique index — a rerun rebuilds the
 * same row (BUILDING → READY, or FAILED with the message preserved), never a
 * duplicate. Delivery is idempotent per UTC day (`lastEmailedOn`).
 */

export const REPORT_METHOD_VERSION = 1 as const;

export interface GenerateOutcome {
  readonly reportId: string;
  readonly kind: ReportKindValue;
  readonly periodLabel: string;
  readonly status: ReportStatusValue;
  readonly errorMessage: string | null;
}

export interface RunDueOutcome {
  readonly preferences: ReportPreferences;
  readonly due: readonly ReportKindValue[];
  readonly generated: readonly GenerateOutcome[];
  readonly emailedTo: string | null;
}

export interface ReportListItem {
  readonly id: string;
  readonly kind: ReportKindValue;
  readonly status: ReportStatusValue;
  readonly periodLabel: string;
  readonly headline: string | null;
  readonly executiveSummary: string | null;
  readonly pdfSizeBytes: number | null;
  readonly lastEmailedOn: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly errorMessage: string | null;
}

export interface ReportDetail extends ReportListItem {
  readonly sections: ReportSectionsData | null;
}

export class ReportNotFoundError extends Error {
  constructor(id: string) {
    super(`report ${id} not found`);
    this.name = "ReportNotFoundError";
  }
}

export interface ReportServiceDeps {
  readonly db: ProfitDb;
  readonly logger: Logger;
  readonly provider: AiProvider | null;
  readonly emailSender: EmailSender | null;
  /** Optional override (DI in tests); undefined → a real ForecastService over db. */
  readonly forecastService?: ForecastService | undefined;
}

function isoDayUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class ReportService {
  private readonly db: ProfitDb;
  private readonly logger: Logger;
  private readonly provider: AiProvider | null;
  private readonly emailSender: EmailSender | null;
  private readonly forecast: ForecastService;

  constructor(deps: ReportServiceDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.provider = deps.provider;
    this.emailSender = deps.emailSender;
    this.forecast = deps.forecastService ?? new ForecastService(deps.db);
  }

  /** Load + parse the merchant's schedule from store settings. */
  async preferencesFor(storeId: string): Promise<ReportPreferences> {
    const rows = await this.db
      .select({ reportPreferences: storeSettings.reportPreferences })
      .from(storeSettings)
      .where(eq(storeSettings.storeId, storeId))
      .limit(1);
    return parseReportPreferences(rows[0]?.reportPreferences);
  }

  /** Latest existing period per kind (due detection input). */
  private async existingPeriodStarts(storeId: string): Promise<{ kind: ReportKindValue; periodStartIso: string }[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({ kind: reports.kind, periodStart: reports.periodStart, status: reports.status })
        .from(reports)
        .where(eq(reports.storeId, storeId));
      return rows
        .filter((row) => row.status !== ReportStatus.Failed) // a failed period retries
        .map((row) => ({ kind: row.kind, periodStartIso: row.periodStart.toISOString().slice(0, 10) }));
    });
  }

  /** Convergent generation for one closed period. Never throws past FAILED. */
  async generateForPeriod(storeId: string, kind: ReportKindValue, period: ReportPeriod, now: Date): Promise<GenerateOutcome> {
    const label = periodLabel(kind, period);
    // Phase 1: claim/reclaim the row (unique index makes this idempotent).
    const claimed = await withStoreScope(this.db, storeId, async (tx) => {
      const upserted = await tx
        .insert(reports)
        .values({
          storeId,
          kind,
          status: ReportStatus.Building,
          periodStart: period.start,
          periodEnd: period.end,
          methodVersion: REPORT_METHOD_VERSION,
          headline: null,
          sections: {},
          executiveSummary: null,
          pdfBytes: null,
          pdfSizeBytes: null,
          completedAt: null,
          errorMessage: null,
        })
        .onConflictDoUpdate({
          target: [reports.storeId, reports.kind, reports.periodStart, reports.periodEnd],
          set: {
            status: ReportStatus.Building,
            methodVersion: REPORT_METHOD_VERSION,
            updatedAt: now,
            errorMessage: null,
          },
        })
        .returning({ id: reports.id });
      const row = upserted[0];
      if (row === undefined) throw new Error("report upsert returned no id");
      return row.id;
    });

    // Phase 2: compute + finalize; failures land as FAILED rows (retried by
    // the next tick — the row's period pointer only counts non-failed rows).
    try {
      const sections = await buildReportSections({
        db: this.db,
        forecast: this.forecast,
        storeId,
        kind,
        period,
        now,
      });
      const summary = await composeExecutiveSummary(this.provider, {
        storeName: sections.storeName,
        kind,
        periodLabel: label,
        kpis: sections.kpis,
        highlights: sections.highlights,
      });
      const pdf = buildReportPdf(sections, summary.summary);
      await withStoreScope(this.db, storeId, async (tx) => {
        await tx
          .update(reports)
          .set({
            status: ReportStatus.Ready,
            headline: sections.headline.slice(0, 280),
            sections: sections as unknown as Record<string, unknown>,
            executiveSummary: summary.summary,
            pdfBytes: pdf,
            pdfSizeBytes: pdf.length,
            completedAt: now,
            updatedAt: now,
            errorMessage: null,
          })
          .where(eq(reports.id, claimed));
      });
      this.logger.info(
        { storeId, reportId: claimed, kind, periodLabel: label, modelEnhanced: summary.modelEnhanced, aiCalls: summary.aiCalls },
        "reports.generate.ready",
      );
      return { reportId: claimed, kind, periodLabel: label, status: ReportStatus.Ready, errorMessage: null };
    } catch (error) {
      const message = (error instanceof Error ? error.message : "unknown").slice(0, 1000);
      this.logger.error({ err: error, storeId, reportId: claimed, kind }, "reports.generate.failed");
      await withStoreScope(this.db, storeId, async (tx) => {
        await tx
          .update(reports)
          .set({ status: ReportStatus.Failed, errorMessage: message, updatedAt: new Date() })
          .where(eq(reports.id, claimed));
      });
      return { reportId: claimed, kind, periodLabel: label, status: ReportStatus.Failed, errorMessage: message };
    }
  }

  /**
   * Scheduled path: evaluate the merchant's schedule, generate what is due,
   * deliver per preferences (email when enabled AND an SMTP sender exists),
   * and notify in-app with a 24h dedupe window.
   */
  async runDue(storeId: string, now: Date): Promise<RunDueOutcome> {
    const preferences = await this.preferencesFor(storeId);
    const existing = await this.existingPeriodStarts(storeId);
    const due = dueKinds(preferences, existing, now);
    const generated: GenerateOutcome[] = [];
    let emailedTo: string | null = null;

    for (const kind of due) {
      const outcome = await this.generateForPeriod(storeId, kind, closedPeriodFor(kind, now), now);
      generated.push(outcome);
      if (outcome.status !== ReportStatus.Ready) continue;

      const recipient = preferences.recipientEmail ?? (await this.storeContactEmail(storeId));
      if (preferences.emailDelivery && this.emailSender !== null && recipient !== null) {
        const delivered = await this.deliver(storeId, outcome.reportId, recipient, now);
        if (delivered.sent) emailedTo = recipient;
      }
      await this.notifyReportReady(storeId, outcome, now);
    }

    return { preferences, due, generated, emailedTo };
  }

  /** In-app notice with a 24h duplicate guard (regeneration is convergent). */
  private async notifyReportReady(storeId: string, outcome: GenerateOutcome, now: Date): Promise<void> {
    const kindWord = outcome.kind.toLowerCase();
    const title = `${kindWord.charAt(0).toUpperCase()}${kindWord.slice(1)} report ready — ${outcome.periodLabel}`;
    await withStoreScope(this.db, storeId, async (tx) => {
      const since = new Date(now.getTime() - 24 * 3_600_000);
      const existing = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.storeId, storeId),
            eq(notifications.title, title),
            gte(notifications.createdAt, since),
          ),
        )
        .limit(1);
      if (existing[0] !== undefined) return;
      await tx.insert(notifications).values({
        storeId,
        category: NotificationCategory.System,
        title,
        body: "Your scheduled report is ready — open Reports to read it or download the PDF.",
        actionUrl: "/reports",
      });
    });
  }

  private async storeContactEmail(storeId: string): Promise<string | null> {
    const rows = await this.db
      .select({ email: stores.email })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    return rows[0]?.email ?? null;
  }

  /** Delivery default: preference recipient, else the store contact email. */
  async defaultRecipientFor(storeId: string): Promise<string | null> {
    const preferences = await this.preferencesFor(storeId);
    return preferences.recipientEmail ?? (await this.storeContactEmail(storeId));
  }

  /**
   * Email one READY report. Idempotent per UTC day: a second call the same
   * day is a no-op (worker retries and double-clicks never re-send).
   */
  async deliver(
    storeId: string,
    reportId: string,
    recipientEmail: string,
    now: Date,
  ): Promise<{ sent: boolean; reason: string | null }> {
    const todayIso = isoDayUTC(now);
    const row = await withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: reports.id,
          status: reports.status,
          lastEmailedOn: reports.lastEmailedOn,
          sections: reports.sections,
          executiveSummary: reports.executiveSummary,
        })
        .from(reports)
        .where(and(eq(reports.id, reportId), eq(reports.storeId, storeId)))
        .limit(1);
      return rows[0];
    });
    if (row === undefined) throw new ReportNotFoundError(reportId);
    if (row.status !== ReportStatus.Ready) return { sent: false, reason: `report is ${row.status.toLowerCase()}` };
    if (row.lastEmailedOn === todayIso) return { sent: false, reason: "already-sent-today" };
    if (this.emailSender === null) return { sent: false, reason: "email-unavailable" };

    const sections = row.sections as unknown as ReportSectionsData;
    const email = renderReportEmail(sections, row.executiveSummary ?? sections.headline);
    await this.emailSender.send({ to: recipientEmail, ...email });
    await withStoreScope(this.db, storeId, async (tx) => {
      await tx
        .update(reports)
        .set({ lastEmailedOn: todayIso, updatedAt: now })
        .where(eq(reports.id, reportId));
    });
    this.logger.info({ storeId, reportId, to: recipientEmail }, "reports.deliver.sent");
    return { sent: true, reason: null };
  }

  async list(storeId: string, kind: ReportKindValue | undefined): Promise<ReportListItem[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(reports)
        .where(
          kind === undefined
            ? eq(reports.storeId, storeId)
            : and(eq(reports.storeId, storeId), eq(reports.kind, kind)),
        )
        .orderBy(desc(reports.periodStart), desc(reports.createdAt))
        .limit(100);
      return rows.map(toListItem);
    });
  }

  async detail(storeId: string, reportId: string): Promise<ReportDetail> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.id, reportId), eq(reports.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new ReportNotFoundError(reportId);
      return {
        ...toListItem(row),
        sections:
          row.executiveSummary === null && Object.keys(row.sections as Record<string, unknown>).length === 0
            ? null
            : (row.sections as unknown as ReportSectionsData),
      };
    });
  }

  /** PDF bytes for the download endpoint (nothing leaves the tenant scope). */
  async pdfFor(storeId: string, reportId: string): Promise<{ bytes: Buffer; filename: string; sizeBytes: number }> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: reports.id,
          kind: reports.kind,
          periodStart: reports.periodStart,
          pdfBytes: reports.pdfBytes,
          pdfSizeBytes: reports.pdfSizeBytes,
          sections: reports.sections,
        })
        .from(reports)
        .where(and(eq(reports.id, reportId), eq(reports.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new ReportNotFoundError(reportId);
      if (row.pdfBytes === null) throw new ReportNotFoundError(reportId);
      const sections = row.sections as unknown as { storeName?: string };
      return {
        bytes: row.pdfBytes,
        filename: reportFilename({
          storeName: sections.storeName ?? "store",
          kind: row.kind,
          startIso: row.periodStart.toISOString().slice(0, 10),
        }),
        sizeBytes: row.pdfSizeBytes ?? row.pdfBytes.length,
      };
    });
  }
}

interface ReportRowShape {
  readonly id: string;
  readonly kind: ReportKindValue;
  readonly status: ReportStatusValue;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly headline: string | null;
  readonly executiveSummary: string | null;
  readonly pdfSizeBytes: number | null;
  readonly lastEmailedOn: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly errorMessage: string | null;
}

function toListItem(row: ReportRowShape): ReportListItem {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    periodLabel: periodLabel(row.kind, { start: row.periodStart, end: row.periodEnd }),
    headline: row.headline,
    executiveSummary: row.executiveSummary,
    pdfSizeBytes: row.pdfSizeBytes,
    lastEmailedOn: row.lastEmailedOn,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  };
}
