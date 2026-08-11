import type { JobHandler } from "@profit/queue";
import {
  BillingService,
  ChurnPreventionService,
  ReconcileService,
  ShopifyBillingProvider,
  TrialLifecycleService,
  UsageRollupService,
  type BillingChargeProvider,
  type ReconcileProvider,
  type TrialMailer,
} from "@profit/billing";
import type { EmailSender } from "@profit/ai";
import { resolveStoreAdminContext, SyncConfigurationError } from "@profit/sync";
import type { WorkerDeps } from "./deps";

/**
 * Billing/growth-plane tick handlers (M5): trial lifecycle (D1–D3 emails,
 * expiry, suspension), convergent usage rollups, Shopify charge reconcile and
 * churn detection. All four are platform-wide scans behind ONE job contract
 * each (packages/billing owns the engines; handlers stay thin wiring).
 *
 * Provider + mailer follow the M4 rule: constructed ONLY when configured —
 * null is a first-class unavailable state the engines count honestly.
 */

/** EmailSender (M4 tool port) → TrialMailer (M5 billing port): identical payloads. */
export function toTrialMailer(sender: EmailSender | null): TrialMailer | null {
  if (sender === null) return null;
  return {
    send: async (email) => {
      await sender.send({
        to: email.to,
        subject: email.subject,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
      });
    },
  };
}

/** Offline-token-resolving provider factory for the reconcile sweep. */
class WorkerReconcileProvider implements ReconcileProvider {
  constructor(private readonly deps: WorkerDeps) {}
  async forStore(storeId: string): Promise<BillingChargeProvider | null> {
    try {
      const admin = await resolveStoreAdminContext(
        this.deps.db.db,
        this.deps.encryption,
        storeId,
        this.deps.offlineCredentialService,
      );
      return new ShopifyBillingProvider(admin.shopDomain, admin.accessToken, this.deps.env.SHOPIFY_API_VERSION);
    } catch (error) {
      if (!(error instanceof SyncConfigurationError)) {
        this.deps.logger.warn({ err: error, storeId }, "billing.reconcile.provider_resolution_failed");
      }
      return null;
    }
  }
}

/** Worker public app URL for email deep links (hosted envs refine-require SHOPIFY_APP_URL). */
function appUrlFor(deps: WorkerDeps): string {
  return deps.env.SHOPIFY_APP_URL ?? "http://localhost:8080";
}

export function billingTrialTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const service = new TrialLifecycleService(
      deps.db.db,
      new BillingService(deps.db.db),
      toTrialMailer(deps.emailSender),
      appUrlFor(deps),
    );
    const report = await service.tick();
    deps.logger.info(
      {
        nudgesSent: report.nudgesSent.length,
        nudgesSkippedNoMailer: report.nudgesSkippedNoMailer,
        trialsExpired: report.trialsExpired.length,
        suspended: report.suspended.length,
      },
      "billing.trial_tick.completed",
    );
  };
}

export function billingUsageRollupTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const report = await new UsageRollupService(deps.db.db).rollUpAll();
    deps.logger.info(report, "billing.usage_rollup.completed");
  };
}

export function billingReconcileTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const service = new ReconcileService(deps.db.db, new BillingService(deps.db.db));
    const report = await service.tick(new WorkerReconcileProvider(deps));
    deps.logger.info(
      {
        settled: report.settled.length,
        cancelledDrift: report.cancelledDrift.length,
        skippedNoProvider: report.skippedNoProvider,
      },
      "billing.reconcile_tick.completed",
    );
  };
}

export function billingChurnScanTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const service = new ChurnPreventionService(
      deps.db.db,
      toTrialMailer(deps.emailSender),
      appUrlFor(deps),
    );
    const report = await service.tick();
    deps.logger.info(
      {
        candidates: report.candidates,
        nudged: report.nudged.length,
        skippedNoMailer: report.skippedNoMailer,
      },
      "billing.churn_scan.completed",
    );
  };
}
