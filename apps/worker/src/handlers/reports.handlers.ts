import { eq } from "@profit/db";
import { stores } from "@profit/db";
import type { JobHandler } from "@profit/queue";
import { ReportService, ReportsGenerateJob, type ReportsGeneratePayload } from "@profit/reporting";
import { ReportStatus, StoreStatus } from "@profit/types";
import { recordWorkerAudit } from "./audit";
import type { WorkerDeps } from "./deps";

/**
 * M8 enterprise reporting pipeline (ADR 34): one tick fans out per active
 * store with a day-stable jobId (tick reruns can't double-generate); each
 * store job converges the merchant's due cadences through the unique
 * (store, kind, period) backstop inside ReportService.
 */

export function reportsTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const day = new Date().toISOString().slice(0, 10);
    const activeStores = await deps.db.db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.status, StoreStatus.Active));
    for (const store of activeStores) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        ReportsGenerateJob,
        { storeId: store.id },
        { jobId: `reports:generate:${day}:${store.id}` },
      );
    }
    deps.logger.info({ stores: activeStores.length, day }, "reports.tick.fanned_out");
  };
}

export function reportsGenerateHandler(deps: WorkerDeps): JobHandler<ReportsGeneratePayload> {
  return async (ctx) => {
    const { storeId } = ctx.payload;
    const service = new ReportService({
      db: deps.db.db,
      logger: deps.logger,
      provider: deps.aiProvider,
      emailSender: deps.emailSender,
    });
    const outcome = await service.runDue(storeId, new Date());
    const failed = outcome.generated.filter((row) => row.status === ReportStatus.Failed);
    if (failed.length > 0) {
      // A FAILED period stays "due" — the job retry (or tomorrow's tick)
      // rebuilds it. Throwing keeps the ledger honest about the partial pass.
      throw new Error(
        `reports.generate: ${failed.length} kind(s) failed — ${failed[0]?.errorMessage ?? "unknown"}`,
      );
    }
    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "reports.due_generated",
      entityType: "store",
      entityId: storeId,
      result: "SUCCESS",
      metadata: {
        due: [...outcome.due],
        generated: outcome.generated.map((row) => ({ kind: row.kind, period: row.periodLabel })),
        emailedTo: outcome.emailedTo,
      },
    });
    deps.logger.info(
      { storeId, due: outcome.due.length, emailedTo: outcome.emailedTo },
      "reports.generate.completed",
    );
  };
}
