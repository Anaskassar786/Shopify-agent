import {
  and,
  eq,
  sql,
  withStoreScope,
  messageSuppressions,
  shopifyCustomers,
  workflowRuns,
  workflowRunSteps,
  workflowVersions,
  workflows,
  stores,
} from "@profit/db";
import type { ProfitDb } from "@profit/db";
import { BillingService } from "@profit/billing";
import {
  ConditionField,
  ConditionOperator,
  MessageChannel,
  UsageMeter,
  WorkflowNodeKind,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowStepStatus,
  WorkflowTriggerKind,
} from "@profit/types";
import { z } from "zod";
import { successorsOf, triggerNodeOf, validateWorkflowDefinition } from "./dag";
import type {
  TriggerConfig,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeConfig,
  WorkflowSubject,
} from "./definition";
import { EMPTY_SUBJECT, workflowSubjectSchema } from "./definition";
import { renderTemplate } from "./template";
import type {
  MessageEmailSender,
  SmsSender,
  WorkflowAdminPort,
} from "./ports";
import { MessageSendError } from "./ports";

/**
 * WorkflowExecutor (M6): the DAG walk engine.
 *
 * Semantics contract (M6 doc §3):
 *  - A run visits each node AT MOST once (acyclic validation + unique
 *    (runId,nodeId) checkpoints) — crash-resume re-walks and SKIPS completed
 *    steps; action side effects are checkpoint-guarded.
 *  - CONDITION gates the walk to the matching branch only.
 *  - DELAY suspends the run (WAITING + resumeAt); the tick resumes it.
 *  - Any action failure is TERMINAL for the run (step FAILED, run FAILED) —
 *    fail-fast beats silent partial automation: the merchant sees the exact
 *    failing node and re-runs after fixing the cause. Provider hiccups never
 *    produce silent duplicate sends from blind retries.
 *  - Sends pass the M5 entitlement gate (access + quota) and the suppression
 *    list — worker jobs are never exempt from billing rules.
 */

export interface WorkflowExecutorDeps {
  readonly db: ProfitDb;
  readonly email: MessageEmailSender | null;
  readonly sms: SmsSender | null;
  /** Offline-token Shopify write surface (null when the store disconnected). */
  readonly adminForStore: (storeId: string) => Promise<WorkflowAdminPort | null>;
  readonly billing?: BillingService;
  /** Shopify Admin API version segment for REST paths (defaults to 2025-01). */
  readonly apiVersion?: string;
}

export interface RunStartInput {
  readonly storeId: string;
  readonly workflowId: string;
  readonly triggerKind: (typeof WorkflowTriggerKind)[keyof typeof WorkflowTriggerKind];
  readonly triggerEventId: string;
  readonly subject?: WorkflowSubject;
}

export interface RunStartResult {
  readonly runId: string;
  /** False when the triggerEventId already produced a run (idempotent fan-out). */
  readonly started: boolean;
}

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const MAX_WALK_ITERATIONS = 500;

export class WorkflowExecutor {
  private readonly billing: BillingService;

  constructor(private readonly deps: WorkflowExecutorDeps) {
    this.billing = deps.billing ?? new BillingService(deps.db);
  }

  /** Create the run row (idempotent) then walk it to completion/suspension/failure. */
  async startRun(input: RunStartInput, now = new Date()): Promise<RunStartResult> {
    const active = await this.loadActiveDefinition(input.storeId, input.workflowId);
    if (active === null) {
      throw new Error("workflow is not active or has no pinned version");
    }
    const subject = input.subject ?? EMPTY_SUBJECT;
    const parsed = workflowSubjectSchema.safeParse(subject);
    if (!parsed.success) throw new Error(`invalid run subject: ${parsed.error.message}`);

    const runId = await withStoreScope(this.deps.db, input.storeId, async (tx) => {
      const inserted = await tx
        .insert(workflowRuns)
        .values({
          storeId: input.storeId,
          workflowId: input.workflowId,
          versionId: active.version.id,
          status: WorkflowRunStatus.Running,
          triggerKind: input.triggerKind,
          triggerEventId: input.triggerEventId,
          subject: parsed.data,
          startedAt: now,
        })
        .onConflictDoNothing({ target: [workflowRuns.workflowId, workflowRuns.triggerEventId] })
        .returning({ id: workflowRuns.id });
      return inserted[0]?.id ?? null;
    });
    if (runId === null) {
      const existing = await this.findRunId(input.storeId, input.workflowId, input.triggerEventId);
      return { runId: existing ?? "", started: false };
    }
    await this.walk(input.storeId, runId, active.definition, parsed.data, now);
    return { runId, started: true };
  }

  private async findRunId(storeId: string, workflowId: string, triggerEventId: string): Promise<string | null> {
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.triggerEventId, triggerEventId)))
        .limit(1);
      return rows[0]?.id ?? null;
    });
  }

  /**
   * Resume a WAITING run. CAS WAITING→RUNNING makes concurrent tick fan-outs
   * no-ops — exactly one resume proceeds even with two workers racing.
   */
  async resumeRun(storeId: string, runId: string, now = new Date()): Promise<{ readonly resumed: boolean }> {
    const claimed = await withStoreScope(this.deps.db, storeId, async (tx) => {
      // CAS claims only runs whose resumeAt already elapsed — a premature
      // resume (buggy fan-out) is rejected at the same lock as double-resume.
      const updated = await tx
        .update(workflowRuns)
        .set({ status: WorkflowRunStatus.Running, resumeAt: null, updatedAt: now })
        .where(
          and(
            eq(workflowRuns.id, runId),
            eq(workflowRuns.status, WorkflowRunStatus.Waiting),
            sql`${workflowRuns.resumeAt} <= ${now}`,
          ),
        )
        .returning({
          workflowId: workflowRuns.workflowId,
          versionId: workflowRuns.versionId,
          resumeFromNodeId: workflowRuns.resumeFromNodeId,
          subject: workflowRuns.subject,
        });
      return updated[0] ?? null;
    });
    if (claimed === null || claimed.resumeFromNodeId === null) return { resumed: false };
    const rawDefinition = await this.loadVersionDefinition(storeId, claimed.workflowId, claimed.versionId);
    if (rawDefinition === null) {
      await this.failRun(storeId, runId, "workflow version no longer available");
      return { resumed: false };
    }
    // Backstop re-validation: run rows are only ever created from validated
    // versions, but the executor never trusts stored shape blindly.
    const validation = validateWorkflowDefinition(rawDefinition);
    if (!validation.ok) {
      await this.failRun(storeId, runId, "stored definition failed backstop validation");
      return { resumed: false };
    }
    const subjectParse = workflowSubjectSchema.safeParse(claimed.subject);
    const subject = subjectParse.success ? subjectParse.data : EMPTY_SUBJECT;
    const edges = successorsOf(validation.definition, claimed.resumeFromNodeId);
    await this.walkFrom(storeId, runId, validation.definition, subject, edges, now);
    return { resumed: true };
  }

  /** Full walk from the trigger node. */
  private async walk(
    storeId: string,
    runId: string,
    rawDefinition: unknown,
    subject: WorkflowSubject,
    now: Date,
  ): Promise<void> {
    const validation = validateWorkflowDefinition(rawDefinition);
    if (!validation.ok) {
      await this.failRun(storeId, runId, "stored definition failed backstop validation");
      return;
    }
    const trigger = triggerNodeOf(validation.definition);
    await this.recordTriggerStep(storeId, runId, trigger, now);
    await this.walkFrom(storeId, runId, validation.definition, subject, successorsOf(validation.definition, trigger.id), now);
  }

  /** BFS over successor edges, honoring branch gating and DELAY suspension. */
  private async walkFrom(
    storeId: string,
    runId: string,
    definition: WorkflowDefinition,
    subject: WorkflowSubject,
    startEdges: readonly WorkflowEdge[],
    now: Date,
  ): Promise<void> {
    const queue: WorkflowEdge[] = [...startEdges];
    let iterations = 0;
    while (queue.length > 0) {
      iterations += 1;
      if (iterations > MAX_WALK_ITERATIONS) {
        await this.failRun(storeId, runId, "walk iteration cap exceeded (graph invariant broken)");
        return;
      }
      const edge = queue.shift()!;
      const node = definition.nodes.find((n) => n.id === edge.to);
      if (node === undefined) continue;
      switch (node.kind) {
        case WorkflowNodeKind.Trigger:
          // Only the root is a trigger; a second one is unreachable by validation.
          continue;
        case WorkflowNodeKind.Condition: {
          const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.Condition];
          const result = evaluateCondition(config, subject);
          await this.completeStep(storeId, runId, node, { result }, now);
          queue.push(...successorsOf(definition, node.id, result ? "YES" : "NO"));
          break;
        }
        case WorkflowNodeKind.Delay: {
          const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.Delay];
          const resumeAt = new Date(now.getTime() + config.minutes * 60_000);
          await this.completeStep(storeId, runId, node, { minutes: config.minutes, resumeAt: resumeAt.toISOString() }, now);
          await this.suspendRun(storeId, runId, node.id, resumeAt, now);
          return; // suspended — the tick resumes the walk
        }
        case WorkflowNodeKind.SendEmail:
        case WorkflowNodeKind.SendSms:
        case WorkflowNodeKind.TagCustomer:
        case WorkflowNodeKind.CreateDiscount: {
          const execution = await this.executeActionNode(storeId, runId, node, subject, definition, now);
          if (!execution.ok) {
            await this.failStepAndRun(storeId, runId, node, execution.error, now);
            return;
          }
          queue.push(...successorsOf(definition, node.id));
          break;
        }
      }
    }
    await this.completeRun(storeId, runId, now);
  }

  /* ─── action execution ─────────────────────────────────────────── */

  private async executeActionNode(
    storeId: string,
    runId: string,
    node: WorkflowNode,
    subject: WorkflowSubject,
    definition: WorkflowDefinition,
    now: Date,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    // Checkpoint guard: a re-walk after a crash finds the completed step and skips.
    const existing = await this.claimStep(storeId, runId, node, now);
    if (existing === "ALREADY_COMPLETED") return { ok: true };
    try {
      const detail = await this.performAction(storeId, runId, node, subject, now);
      await this.completeStep(storeId, runId, node, detail, now);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown action error";
      return { ok: false, error: `${node.kind}: ${message}` };
    }
  }

  private async performAction(
    storeId: string,
    runId: string,
    node: WorkflowNode,
    subject: WorkflowSubject,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const storeInfo = await this.loadStoreInfo(storeId);
    switch (node.kind) {
      case WorkflowNodeKind.SendEmail: {
        const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.SendEmail];
        const to = subject.customer?.email ?? null;
        if (to === null) throw new MessageSendError("run subject has no customer email", false);
        if (this.deps.email === null) throw new MessageSendError("email provider not configured (SMTP env missing)", true);
        await this.assertQuota(storeId, UsageMeter.EmailsSent);
        await this.assertNotSuppressed(storeId, MessageChannel.Email, to);
        const context = {
          store: { name: storeInfo.name, domain: storeInfo.shopDomain },
          customer: templateCustomer(subject),
          workflow: { name: await this.workflowName(storeId, runId) },
        };
        const renderedSubject = renderTemplate(config.subject, context);
        const textBody = renderTemplate(config.bodyText, context);
        const htmlBody = renderTemplate(config.bodyHtml ?? escapeToHtmlShell(textBody), context, { html: true });
        const sent = await this.deps.email.send({ to, subject: renderedSubject, textBody, htmlBody });
        return { to, subject: renderedSubject, messageId: sent.messageId };
      }
      case WorkflowNodeKind.SendSms: {
        const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.SendSms];
        const to = subject.customer?.phone ?? null;
        if (to === null) throw new MessageSendError("run subject has no customer phone", false);
        if (!E164_PATTERN.test(to)) throw new MessageSendError("customer phone is not E.164", false);
        if (this.deps.sms === null) throw new MessageSendError("sms provider not configured (Twilio env missing)", true);
        await this.assertQuota(storeId, UsageMeter.SmsSent);
        await this.assertNotSuppressed(storeId, MessageChannel.Sms, to);
        const body = renderTemplate(config.bodyText, {
          store: { name: storeInfo.name, domain: storeInfo.shopDomain },
          customer: templateCustomer(subject),
          workflow: { name: await this.workflowName(storeId, runId) },
        });
        const sent = await this.deps.sms.send({ to, body });
        return { to, providerRef: sent.providerRef };
      }
      case WorkflowNodeKind.TagCustomer: {
        const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.TagCustomer];
        const shopifyCustomerId = subject.customer?.shopifyCustomerId ?? null;
        const customerId = subject.customer?.id ?? null;
        if (shopifyCustomerId === null || customerId === null) {
          throw new MessageSendError("run subject has no linked Shopify customer", false);
        }
        const admin = await this.deps.adminForStore(storeId);
        if (admin === null) throw new MessageSendError("store admin context unavailable (reinstall?)", true);
        const currentTags = subject.customer?.tags ?? [];
        const merged = currentTags.includes(config.tag) ? currentTags : [...currentTags, config.tag];
        await admin.putJson(`/admin/api/${storeInfo.apiVersion}/customers/${shopifyCustomerId}.json`, {
          customer: { id: Number(shopifyCustomerId), tags: merged.join(", ") },
        });
        // Update the local replica immediately; the webhook echo re-confirms.
        await withStoreScope(this.deps.db, storeId, async (tx) => {
          await tx
            .update(shopifyCustomers)
            .set({ tags: merged, updatedAt: now })
            .where(and(eq(shopifyCustomers.id, customerId), eq(shopifyCustomers.storeId, storeId)));
        });
        return { tag: config.tag, shopifyCustomerId };
      }
      case WorkflowNodeKind.CreateDiscount: {
        const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.CreateDiscount];
        const admin = await this.deps.adminForStore(storeId);
        if (admin === null) throw new MessageSendError("store admin context unavailable (reinstall?)", true);
        // Crash-resume: a previous attempt's priceRuleId rides in the step detail.
        const prior = await this.stepDetail(storeId, runId, node.id);
        let priceRuleId = typeof prior?.["priceRuleId"] === "string" ? (prior["priceRuleId"] as string) : null;
        if (priceRuleId === null) {
          const startsAt = new Date();
          const endsAt = new Date(startsAt.getTime() + config.expiresInDays * 86_400_000);
          const ruleResponse = await admin.postJson(`/admin/api/${storeInfo.apiVersion}/price_rules.json`, {
            price_rule: {
              title: `${config.code} — workflow ${runId.slice(0, 8)}`,
              target_type: "line_item",
              target_selection: "all",
              allocation_method: "across",
              value_type: "percentage",
              value: `-${config.percentOff}`,
              customer_selection: "all",
              once_per_customer: true,
              starts_at: startsAt.toISOString(),
              ends_at: endsAt.toISOString(),
            },
          });
          priceRuleId = String(priceRuleIdSchema.parse(ruleResponse).price_rule.id);
          await this.patchStepDetail(storeId, runId, node.id, { priceRuleId });
        }
        const codeResponse = await admin.postJson(
          `/admin/api/${storeInfo.apiVersion}/price_rules/${priceRuleId}/discount_codes.json`,
          { discount_code: { code: config.code } },
        );
        const codeResult = discountCodeSchema.parse(codeResponse);
        return { priceRuleId, discountCodeId: String(codeResult.discount_code.id), code: codeResult.discount_code.code };
      }
      case WorkflowNodeKind.Trigger:
      case WorkflowNodeKind.Condition:
      case WorkflowNodeKind.Delay:
        throw new Error(`node kind ${node.kind} is not an action`);
    }
  }

  private async assertQuota(storeId: string, meter: (typeof UsageMeter)[keyof typeof UsageMeter]): Promise<void> {
    const denial = await this.billing.checkEntitlement(storeId, meter, 1);
    if (denial !== null) throw new MessageSendError(denial.message, false);
  }

  private async assertNotSuppressed(
    storeId: string,
    channel: (typeof MessageChannel)[keyof typeof MessageChannel],
    destination: string,
  ): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({ id: messageSuppressions.id })
        .from(messageSuppressions)
        .where(
          and(
            eq(messageSuppressions.storeId, storeId),
            eq(messageSuppressions.channel, channel),
            eq(messageSuppressions.destination, destination),
          ),
        )
        .limit(1);
      if (rows[0] !== undefined) throw new MessageSendError("destination is suppressed (unsubscribed)", false);
    });
  }

  /* ─── persistence primitives ───────────────────────────────────── */

  /**
   * Idempotent step claim: insert RUNNING or inspect the existing row.
   * Returns ALREADY_COMPLETED so re-walks skip done work.
   */
  private async claimStep(
    storeId: string,
    runId: string,
    node: WorkflowNode,
    now: Date,
  ): Promise<"CLAIMED" | "ALREADY_COMPLETED"> {
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const inserted = await tx
        .insert(workflowRunSteps)
        .values({
          storeId,
          runId,
          nodeId: node.id,
          nodeKind: node.kind,
          status: WorkflowStepStatus.Running,
          attempts: 1,
          startedAt: now,
        })
        .onConflictDoNothing({ target: [workflowRunSteps.runId, workflowRunSteps.nodeId] })
        .returning({ id: workflowRunSteps.id });
      if (inserted[0] !== undefined) return "CLAIMED";
      const rows = await tx
        .select({ status: workflowRunSteps.status })
        .from(workflowRunSteps)
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.nodeId, node.id)))
        .limit(1);
      const status = rows[0]?.status;
      if (status === WorkflowStepStatus.Completed) return "ALREADY_COMPLETED";
      // Stale RUNNING from a crashed attempt — re-claim by bumping attempts.
      await tx
        .update(workflowRunSteps)
        .set({ attempts: sql`${workflowRunSteps.attempts} + 1`, updatedAt: now })
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.nodeId, node.id)));
      return "CLAIMED";
    });
  }

  private async completeStep(
    storeId: string,
    runId: string,
    node: WorkflowNode,
    detail: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .insert(workflowRunSteps)
        .values({
          storeId,
          runId,
          nodeId: node.id,
          nodeKind: node.kind,
          status: WorkflowStepStatus.Completed,
          attempts: 1,
          detail,
          startedAt: now,
          completedAt: now,
        })
        .onConflictDoUpdate({
          target: [workflowRunSteps.runId, workflowRunSteps.nodeId],
          set: { status: WorkflowStepStatus.Completed, detail, completedAt: now, updatedAt: now },
        });
    });
  }

  private async recordTriggerStep(
    storeId: string,
    runId: string,
    trigger: WorkflowNode,
    now: Date,
  ): Promise<void> {
    const config = trigger.config as TriggerConfig;
    await this.completeStep(storeId, runId, trigger, { triggerKind: config.kind }, now);
  }

  private async failStepAndRun(
    storeId: string,
    runId: string,
    node: WorkflowNode,
    error: string,
    now: Date,
  ): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(workflowRunSteps)
        .set({
          status: WorkflowStepStatus.Failed,
          error,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.nodeId, node.id)));
      await tx
        .update(workflowRuns)
        .set({ status: WorkflowRunStatus.Failed, error, completedAt: now, updatedAt: now })
        .where(eq(workflowRuns.id, runId));
    });
  }

  private async suspendRun(
    storeId: string,
    runId: string,
    delayNodeId: string,
    resumeAt: Date,
    now: Date,
  ): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(workflowRuns)
        .set({
          status: WorkflowRunStatus.Waiting,
          resumeAt,
          resumeFromNodeId: delayNodeId,
          updatedAt: now,
        })
        .where(eq(workflowRuns.id, runId));
    });
  }

  private async completeRun(storeId: string, runId: string, now: Date): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(workflowRuns)
        .set({ status: WorkflowRunStatus.Completed, completedAt: now, updatedAt: now })
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, WorkflowRunStatus.Running)));
    });
  }

  private async failRun(storeId: string, runId: string, error: string): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(workflowRuns)
        .set({ status: WorkflowRunStatus.Failed, error, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(workflowRuns.id, runId));
    });
  }

  /** Steps of a run (run-detail API). */
  async listSteps(
    storeId: string,
    runId: string,
  ): Promise<ReadonlyArray<{
    readonly nodeId: string;
    readonly nodeKind: (typeof WorkflowNodeKind)[keyof typeof WorkflowNodeKind];
    readonly status: (typeof WorkflowStepStatus)[keyof typeof WorkflowStepStatus];
    readonly attempts: number;
    readonly detail: unknown;
    readonly error: string | null;
    readonly completedAt: Date | null;
  }>> {
    return withStoreScope(this.deps.db, storeId, async (tx) =>
      tx
        .select({
          nodeId: workflowRunSteps.nodeId,
          nodeKind: workflowRunSteps.nodeKind,
          status: workflowRunSteps.status,
          attempts: workflowRunSteps.attempts,
          detail: workflowRunSteps.detail,
          error: workflowRunSteps.error,
          completedAt: workflowRunSteps.completedAt,
        })
        .from(workflowRunSteps)
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.storeId, storeId)))
        .orderBy(workflowRunSteps.createdAt),
    );
  }

  /* ─── loaders ──────────────────────────────────────────────────── */

  private async loadActiveDefinition(
    storeId: string,
    workflowId: string,
  ): Promise<{ readonly version: { readonly id: string }; readonly definition: unknown } | null> {
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          status: workflows.status,
          activeVersionId: workflows.activeVersionId,
        })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.storeId, storeId)))
        .limit(1);
      const row = rows[0];
      if (row === undefined || row.status !== WorkflowStatus.Active || row.activeVersionId === null) return null;
      return { version: { id: row.activeVersionId }, definition: await this.definitionById(tx, storeId, row.activeVersionId) };
    });
  }

  private async loadVersionDefinition(
    storeId: string,
    _workflowId: string,
    versionId: string,
  ): Promise<unknown | null> {
    return withStoreScope(this.deps.db, storeId, async (tx) => this.definitionById(tx, storeId, versionId));
  }

  private async definitionById(tx: ProfitDb, storeId: string, versionId: string): Promise<unknown | null> {
    const rows = await tx
      .select({ definition: workflowVersions.definition })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.storeId, storeId)))
      .limit(1);
    return rows[0]?.definition ?? null;
  }

  private async loadStoreInfo(
    storeId: string,
  ): Promise<{ readonly name: string; readonly shopDomain: string; readonly apiVersion: string }> {
    const rows = await this.deps.db
      .select({ name: stores.name, shopDomain: stores.shopDomain })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new MessageSendError("store not found for run", false);
    return { ...row, apiVersion: this.deps.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION };
  }

  private async workflowName(storeId: string, runId: string): Promise<string> {
    const rows = await this.deps.db
      .select({ name: workflows.name })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    void storeId;
    return rows[0]?.name ?? "workflow";
  }

  private async stepDetail(storeId: string, runId: string, nodeId: string): Promise<Record<string, unknown> | null> {
    return withStoreScope(this.deps.db, storeId, async (tx) => {
      const rows = await tx
        .select({ detail: workflowRunSteps.detail })
        .from(workflowRunSteps)
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.nodeId, nodeId)))
        .limit(1);
      const detail = rows[0]?.detail;
      return typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : null;
    });
  }

  private async patchStepDetail(
    storeId: string,
    runId: string,
    nodeId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await withStoreScope(this.deps.db, storeId, async (tx) => {
      await tx
        .update(workflowRunSteps)
        .set({ detail: sql`${workflowRunSteps.detail} || ${JSON.stringify(patch)}::jsonb` })
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.nodeId, nodeId)));
    });
  }
}

/* ─── condition evaluation (pure, exported for unit tests) ────────── */

const numberFields: ReadonlySet<string> = new Set([
  ConditionField.CustomerOrdersCount,
  ConditionField.CustomerTotalSpentCents,
  ConditionField.EventTotalCents,
]);

export function evaluateCondition(
  config: {
    readonly field: (typeof ConditionField)[keyof typeof ConditionField];
    readonly operator: (typeof ConditionOperator)[keyof typeof ConditionOperator];
    readonly value: string | number | boolean;
  },
  subject: WorkflowSubject,
): boolean {
  const customer = subject.customer ?? null;
  const event = subject.event ?? null;
  let actual: string | number | boolean | readonly string[] | null = null;
  switch (config.field) {
    case ConditionField.CustomerOrdersCount:
      actual = customer?.ordersCount ?? null;
      break;
    case ConditionField.CustomerTotalSpentCents:
      actual = customer?.totalSpentCents ?? null;
      break;
    case ConditionField.CustomerAcceptsMarketing:
      actual = customer?.acceptsMarketing ?? null;
      break;
    case ConditionField.CustomerTag:
      actual = customer?.tags !== undefined ? [...customer.tags] : null;
      break;
    case ConditionField.EventTotalCents:
      actual = event?.totalCents ?? null;
      break;
    case ConditionField.EventCurrency:
      actual = event?.currency ?? null;
      break;
  }
  if (actual === null) return false;

  if (config.field === ConditionField.CustomerTag) {
    const tags = Array.isArray(actual) ? (actual as readonly string[]) : [];
    return config.operator === ConditionOperator.Contains
      ? tags.includes(String(config.value))
      : config.operator === ConditionOperator.NotEquals
        ? !tags.includes(String(config.value))
        : false;
  }

  if (numberFields.has(config.field)) {
    const left = typeof actual === "number" ? actual : Number.NaN;
    const right = typeof config.value === "number" ? config.value : Number(config.value);
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    switch (config.operator) {
      case ConditionOperator.Equals: return left === right;
      case ConditionOperator.NotEquals: return left !== right;
      case ConditionOperator.GreaterThan: return left > right;
      case ConditionOperator.GreaterThanOrEqual: return left >= right;
      case ConditionOperator.LessThan: return left < right;
      case ConditionOperator.LessThanOrEqual: return left <= right;
      case ConditionOperator.Contains: return false;
    }
  }

  // String/boolean equality (case-insensitive for strings — merchant-friendly).
  const left = String(actual).toLowerCase();
  const right = String(config.value).toLowerCase();
  switch (config.operator) {
    case ConditionOperator.Equals: return left === right;
    case ConditionOperator.NotEquals: return left !== right;
    case ConditionOperator.Contains: return left.includes(right);
    case ConditionOperator.GreaterThan:
    case ConditionOperator.GreaterThanOrEqual:
    case ConditionOperator.LessThan:
    case ConditionOperator.LessThanOrEqual:
      return false;
  }
}

function templateCustomer(subject: WorkflowSubject): {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly ordersCount: number | undefined;
  readonly totalSpent: string | undefined;
} {
  const customer = subject.customer ?? null;
  return {
    firstName: customer?.firstName ?? null,
    lastName: customer?.lastName ?? null,
    email: customer?.email ?? null,
    ordersCount: customer?.ordersCount,
    totalSpent:
      customer?.totalSpentCents !== undefined
        ? `$${(customer.totalSpentCents / 100).toFixed(2)}`
        : undefined,
  };
}

/** Plain-text → minimal HTML shell for bodies without an explicit HTML twin. */
function escapeToHtmlShell(text: string): string {
  const escape = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return text
    .split("\n")
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
}

const priceRuleIdSchema = z.object({ price_rule: z.object({ id: z.number() }) });
const discountCodeSchema = z.object({ discount_code: z.object({ id: z.number(), code: z.string() }) });

export const DEFAULT_SHOPIFY_API_VERSION = "2025-01";
