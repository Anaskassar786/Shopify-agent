import { and, eq } from "@profit/db";
import { shopifyCustomers } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  CampaignDispatchJob,
  CampaignSendBatchJob,
  CampaignSender,
  CampaignService,
  ExportGenerateJob,
  ExportService,
  SupportNotifyJob,
  SupportService,
  WorkflowExecutor,
  WorkflowRunResumeJob,
  WorkflowRunStartJob,
  WorkflowService,
  type WorkflowAdminPort,
  type WorkflowSubject,
  AutomationTickJob,
} from "@profit/automation";
import { shopifyPostJson, shopifyPutJson } from "@profit/shopify";
import { resolveStoreAdminContext } from "@profit/sync";
import { NotificationService } from "@profit/notifications";
import type { JobHandler } from "@profit/queue";
import { NotificationCategory, WorkflowTriggerKind } from "@profit/types";
import type {
  CampaignDispatchPayload,
  CampaignSendBatchPayload,
  ExportGeneratePayload,
  SupportNotifyPayload,
  WorkflowRunResumePayload,
  WorkflowRunStartPayload,
} from "@profit/automation";
import { recordWorkerAudit } from "./audit";
import type { WorkerDeps } from "./deps";

/**
 * M6 Automation Center data-plane. One TICK scans the entire plane and fans
 * out deterministic leaf jobs (P3 scheduler taxonomy); every fan-out row
 * carries a uniqueness key, so overlapping ticks double-scan, never
 * double-execute. Leaf jobs re-derive ALL state from Postgres on each
 * attempt (cursor in payload = keyset position; rows are the truth), making
 * retries convergent rather than replay-prone.
 *
 * Failure-mode story (documented, not hidden):
 *  - schedule leaf: run.unique(workflowId, triggerEventId) dedupes replays;
 *    nextFireAt CAS (advanceSchedule) guards the cursor.
 *  - campaign chain: per-recipient rows are idempotent checkpoints; a crash
 *    between a batch's writes and its next-link enqueue leaves the campaign
 *    SENDING with pending recipients — visible + honest (manual re-dispatch
 *    is a CAS no-op; support runbook resumes by re-enqueuing send-batch).
 */

/** Offline-token REST write surface for workflow actions (tag/customer, price rules). */
async function adminPortFor(deps: WorkerDeps, storeId: string): Promise<WorkflowAdminPort | null> {
  try {
    const admin = await resolveStoreAdminContext(deps.db.db, deps.encryption, storeId);
    const headers = { "X-Shopify-Access-Token": admin.accessToken };
    const options = {
      maxRetries: deps.env.SHOPIFY_HTTP_MAX_RETRIES,
      baseDelayMs: deps.env.SHOPIFY_HTTP_BASE_DELAY_MS,
    };
    return {
      postJson: (path, body) =>
        shopifyPostJson(`https://${admin.shopDomain}${path}`, body, headers, options),
      putJson: (path, body) =>
        shopifyPutJson(`https://${admin.shopDomain}${path}`, body, headers, options),
    };
  } catch (error) {
    deps.logger.warn({ err: error, storeId }, "automation.admin_context_unresolvable");
    return null;
  }
}

function executorFor(deps: WorkerDeps): WorkflowExecutor {
  return new WorkflowExecutor({
    db: deps.db.db,
    email: deps.emailSender,
    sms: deps.smsSender,
    adminForStore: (storeId) => adminPortFor(deps, storeId),
    apiVersion: deps.env.SHOPIFY_API_VERSION,
  });
}

function campaignSenderFor(deps: WorkerDeps): CampaignSender {
  return new CampaignSender({
    db: deps.db.db,
    email: deps.emailSender,
    sms: deps.smsSender,
    trackingSecret: deps.trackingSecret,
    trackingBaseUrl: deps.trackingBaseUrl,
    batchSize: deps.env.CAMPAIGN_SEND_BATCH_SIZE,
  });
}

/**
 * automation.tick — the M6 scheduler heartbeat:
 *   1. schedule-due ACTIVE workflows → run-start (triggerEventId pins the instant) + CAS-advance;
 *   2. delay-elapsed WAITING runs → run-resume (dedupe includes resumeAt: multi-DELAY graphs
 *      can WAIT several times per run);
 *   3. scheduled campaigns at/before now → dispatch;
 *   4. expired exports sweep (one cheap owner-role statement, inline).
 */
export function automationTickHandler(deps: WorkerDeps): JobHandler<Record<string, never>> {
  return async () => {
    const now = new Date();
    const workflows = new WorkflowService(deps.db.db);
    const campaigns = new CampaignService(deps.db.db);
    const exportsSvc = new ExportService(deps.db.db);

    const scheduleDue = await workflows.findScheduleDue(now);
    for (const due of scheduleDue) {
      const fireAtMs = due.nextFireAt.getTime();
      const next = await workflows.nextFireAfter(due.storeId, due.workflowId, now);
      const advanced = await workflows.advanceSchedule(due.storeId, due.workflowId, due.nextFireAt, next);
      // Enqueue even when the CAS lost: the winning tick enqueued the same
      // deterministic jobId (queue + persistence dedupe), and the run row's
      // unique(workflowId, triggerEventId) is the final lock.
      await deps.persistence.enqueuePersistent(
        deps.queue,
        WorkflowRunStartJob,
        {
          storeId: due.storeId,
          workflowId: due.workflowId,
          triggerKind: WorkflowTriggerKind.Schedule,
          triggerEventId: `schedule:${due.workflowId}:${String(fireAtMs)}`,
        },
        { jobId: `wf-schedule:${due.workflowId}:${String(fireAtMs)}` },
      );
      if (!advanced) {
        deps.logger.debug(
          { workflowId: due.workflowId, fireAt: due.nextFireAt.toISOString() },
          "automation.tick.advance_lost_cas",
        );
      }
    }

    const resumeDue = await workflows.findResumeDue(now);
    for (const due of resumeDue) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        WorkflowRunResumeJob,
        { storeId: due.storeId, runId: due.runId },
        { jobId: `wf-resume:${due.runId}:${String(due.resumeAt.getTime())}` },
      );
    }

    const dispatchDue = await campaigns.findDispatchDue(now);
    for (const due of dispatchDue) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        CampaignDispatchJob,
        { storeId: due.storeId, campaignId: due.campaignId },
        { jobId: `campaign-dispatch:${due.campaignId}` },
      );
    }

    const expired = await exportsSvc.sweepExpired(now);
    deps.logger.info(
      {
        schedulesFired: scheduleDue.length,
        resumesQueued: resumeDue.length,
        campaignsDispatched: dispatchDue.length,
        exportsExpired: expired,
      },
      "automation.tick.completed",
    );
  };
}

/** automation.run-start — create the run row (idempotent) and walk the graph. */
export function workflowRunStartHandler(deps: WorkerDeps): JobHandler<WorkflowRunStartPayload> {
  return async (ctx) => {
    const executor = executorFor(deps);
    const outcome = await executor.startRun({
      storeId: ctx.payload.storeId,
      workflowId: ctx.payload.workflowId,
      triggerKind: ctx.payload.triggerKind,
      triggerEventId: ctx.payload.triggerEventId,
      ...(ctx.payload.subject !== undefined ? { subject: ctx.payload.subject } : {}),
    });
    if (outcome.started) {
      deps.logger.info(
        { storeId: ctx.payload.storeId, workflowId: ctx.payload.workflowId, runId: outcome.runId },
        "automation.run.started",
      );
    }
  };
}

/** automation.run-resume — CAS WAITING→RUNNING then continue the walk (idempotent). */
export function workflowRunResumeHandler(deps: WorkerDeps): JobHandler<WorkflowRunResumePayload> {
  return async (ctx) => {
    const executor = executorFor(deps);
    const { resumed } = await executor.resumeRun(ctx.payload.storeId, ctx.payload.runId);
    if (!resumed) {
      deps.logger.debug(
        { storeId: ctx.payload.storeId, runId: ctx.payload.runId },
        "automation.run.resume_noop",
      );
    }
  };
}

/**
 * campaigns.dispatch — SCHEDULED→SENDING CAS + audience materialization, then
 * kick the keyset send chain. The first link's jobId is deterministic
 * (`campaign-send:{id}:cursor:start`) so a retried dispatch never forks two
 * chains.
 */
export function campaignDispatchHandler(deps: WorkerDeps): JobHandler<CampaignDispatchPayload> {
  return async (ctx) => {
    const { storeId, campaignId } = ctx.payload;
    const campaigns = new CampaignService(deps.db.db);
    const outcome = await campaigns.dispatch(storeId, campaignId);
    if (!outcome.dispatched) return; // CAS lost: another attempt owns the chain.
    if (outcome.recipientCount > 0) {
      await deps.persistence.enqueuePersistent(
        deps.queue,
        CampaignSendBatchJob,
        { storeId, campaignId, afterRecipientId: null },
        { jobId: `campaign-send:${campaignId}:cursor:start`, delayMs: deps.env.CAMPAIGN_SEND_THROTTLE_MS },
      );
    }
    await recordWorkerAudit(deps.db.db, deps.logger, {
      storeId,
      action: "campaign.dispatched",
      entityType: "campaign",
      entityId: campaignId,
      result: "SUCCESS",
      metadata: { recipientCount: outcome.recipientCount },
    });
  };
}

/**
 * campaigns.send-batch — send up to CAMPAIGN_SEND_BATCH_SIZE recipients after
 * the keyset cursor, then self-chain with throttle. Terminals: exhausted →
 * CAS-complete + merchant notification; fatalError → campaign FAILED + notice.
 */
export function campaignSendBatchHandler(deps: WorkerDeps): JobHandler<CampaignSendBatchPayload> {
  return async (ctx) => {
    const { storeId, campaignId, afterRecipientId } = ctx.payload;
    const sender = campaignSenderFor(deps);
    const outcome = await sender.sendBatch(storeId, campaignId, afterRecipientId);

    if (outcome.fatalError !== null) {
      const campaigns = new CampaignService(deps.db.db);
      await campaigns.failCampaign(storeId, campaignId, outcome.fatalError);
      await notify(deps, storeId, {
        title: "Campaign failed",
        body: `Your campaign could not be sent: ${outcome.fatalError}. Review the campaign and try again.`,
        actionUrl: "/campaigns",
      });
      await recordWorkerAudit(deps.db.db, deps.logger, {
        storeId,
        action: "campaign.failed",
        entityType: "campaign",
        entityId: campaignId,
        result: "FAILURE",
        metadata: { reason: outcome.fatalError },
      });
      return;
    }

    if (outcome.exhausted) {
      const campaigns = new CampaignService(deps.db.db);
      const completed = await campaigns.completeCampaign(storeId, campaignId);
      if (completed) {
        await notify(deps, storeId, {
          title: "Campaign sent",
          body: "Your campaign finished sending. Open the campaign to review delivery, open and click performance.",
          actionUrl: "/campaigns",
        });
        await recordWorkerAudit(deps.db.db, deps.logger, {
          storeId,
          action: "campaign.sent",
          entityType: "campaign",
          entityId: campaignId,
          result: "SUCCESS",
          metadata: {},
        });
      }
      return;
    }

    await deps.persistence.enqueuePersistent(
      deps.queue,
      CampaignSendBatchJob,
      { storeId, campaignId, afterRecipientId: outcome.lastRecipientId },
      {
        jobId: `campaign-send:${campaignId}:cursor:${outcome.lastRecipientId ?? "start"}`,
        delayMs: deps.env.CAMPAIGN_SEND_THROTTLE_MS,
      },
    );
  };
}

/** exports.generate — build the file bytes + READY CAS (service is idempotent). */
export function exportGenerateHandler(deps: WorkerDeps): JobHandler<ExportGeneratePayload> {
  return async (ctx) => {
    const { storeId, exportId } = ctx.payload;
    const service = new ExportService(deps.db.db);
    const outcome = await service.generate(storeId, exportId);
    if (!outcome.generated) return; // CAS lost or already terminal — honest no-op.
    const row = await service.getExport(storeId, exportId);
    if (row !== null) {
      await notify(deps, storeId, {
        title: row.status === "READY" ? "Export ready" : "Export failed",
        body:
          row.status === "READY"
            ? `Your ${String(row.kind).toLowerCase()} export (${String(row.rowCount ?? 0)} rows) is ready to download. It expires in 7 days.`
            : `Your ${String(row.kind).toLowerCase()} export failed: ${row.error ?? "unknown error"}. Request a new export.`,
        actionUrl: "/exports",
      });
    }
  };
}

/**
 * support.notify — operator reply fan-out: email to the ticket opener (when
 * reachable + configured) and an in-app notification row either way.
 */
export function supportNotifyHandler(deps: WorkerDeps): JobHandler<SupportNotifyPayload> {
  return async (ctx) => {
    const { ticketId, messageId } = ctx.payload;
    const support = new SupportService(deps.db.db);
    const context = await support.loadNotifyContext(ticketId, messageId);
    if (context === null) return; // Ticket/message vanished — nothing honest to notify about.

    const subject = `Support reply: ${context.subject}`;
    const preview = context.body.length > 300 ? `${context.body.slice(0, 299)}…` : context.body;
    await notify(deps, context.storeId, {
      title: `Support replied to “${context.subject}”`,
      body: preview,
      actionUrl: "/support",
    });

    if (deps.emailSender !== null && context.openerEmail !== null) {
      await deps.emailSender.send({
        to: context.openerEmail,
        subject,
        textBody: `${context.body}\n\n— Profit Tool AI support${context.operator !== null ? ` (${context.operator})` : ""}\nReply in-app under Support to continue this thread.`,
        htmlBody: `<p>${escapeHtml(context.body)}</p><p>— Profit Tool AI support${context.operator !== null ? ` (${escapeHtml(context.operator)})` : ""}<br/>Reply in-app under <b>Support</b> to continue this thread.</p>`,
      });
    } else if (context.openerEmail !== null) {
      deps.logger.info(
        { storeId: context.storeId, ticketId },
        "support.notify.email_skipped_unconfigured",
      );
    }
  };
}

/**
 * Webhook fan-out helper — resolve the local customer replica row into a run
 * subject (order/checkout/customer topics). Null customer when the replica
 * row does not exist (appliers upsert on their own cadence; the trigger
 * still fires and steps handle a null subject honestly).
 */
export async function buildEventSubject(
  db: ProfitDb,
  storeId: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<WorkflowSubject> {
  const customerRef = readShopifyCustomerId(topic, payload);
  let customer: WorkflowSubject["customer"] = null;
  if (customerRef !== null) {
    const rows = await db
      .select()
      .from(shopifyCustomers)
      .where(and(eq(shopifyCustomers.storeId, storeId), eq(shopifyCustomers.shopifyCustomerId, customerRef)))
      .limit(1);
    const row = rows[0];
    if (row !== undefined) {
      customer = {
        id: row.id,
        shopifyCustomerId: row.shopifyCustomerId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        ordersCount: row.ordersCount,
        totalSpentCents: Math.round(Number(row.totalSpent) * 100),
        acceptsMarketing: row.acceptsMarketing,
        tags: row.tags,
      };
    }
  }
  const totalCents = readMoney(payload["total_price"]);
  const currency = typeof payload["currency"] === "string" && payload["currency"].length === 3
    ? payload["currency"]
    : null;
  const rawId = typeof payload["id"] === "string" || typeof payload["id"] === "number"
    ? String(payload["id"])
    : null;
  return {
    customer,
    event: {
      topic,
      totalCents,
      currency,
      orderId: topic.startsWith("orders/") ? rawId : null,
      checkoutId: topic.startsWith("checkouts/") ? rawId : null,
    },
  };
}

function readShopifyCustomerId(topic: string, payload: Record<string, unknown>): string | null {
  if (topic.startsWith("customers/")) {
    const id = payload["id"];
    return typeof id === "string" || typeof id === "number" ? String(id) : null;
  }
  const customer = payload["customer"];
  if (typeof customer === "object" && customer !== null) {
    const id = (customer as Record<string, unknown>)["id"];
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return null;
}

/** Shopify REST money fields are decimal strings; cents round, never float-sum. */
function readMoney(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

async function notify(
  deps: WorkerDeps,
  storeId: string,
  input: { title: string; body: string; actionUrl: string },
): Promise<void> {
  // NotificationService persists the row then publishes the realtime hint.
  await new NotificationService(deps.db.db, deps.pubsub).create(storeId, {
    category: NotificationCategory.Automation,
    ...input,
  });
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
