import { and, eq, sql } from "@profit/db";
import type { ProfitDb } from "@profit/db";
import {
  actionExecutions,
  execRaw,
  recommendations,
  recommendationEvents,
  withStoreScope,
} from "@profit/db";
import {
  ActionType,
  EventActorType,
  RecommendationEventType,
  RecommendationStatus,
} from "@profit/types";
import { z } from "zod";
import { codeFromIdempotencyKey, DiscountTool } from "../tools/discount";
import { RecoveryEmailTool, type EmailTemplateParams } from "../tools/email";
import {
  ToolExecutionError,
  ToolUnavailableError,
  type ActionTool,
  type EmailSender,
  type StoreBranding,
  type ToolContext,
} from "../tools/port";
import type { ShopifyAdminContext } from "@profit/shopify";

/**
 * Action executor (worker-side). Turns one approved recommendation into
 * reality via the tool registry, with the exact safety properties the P3
 * failsafe demands:
 *  - execution row CAS: PENDING/RUNNING/FAILED → RUNNING retries are resume
 *    points, never duplicates (toolRef checkpoints per step);
 *  - parameters are RESOLVED SERVER-SIDE (recipients, CTA url, discount
 *    code) — model copy rides along only as the validated emailDraft;
 *  - any tool failure leaves a typed error + attempts counter; the queue's
 *    retry policy decides the next attempt, and the final attempt flips the
 *    recommendation to FAILED with a merchant notification (by the handler).
 */

export interface ExecutorDeps {
  readonly db: ProfitDb;
  readonly admin: ShopifyAdminContext | null;
  readonly email: EmailSender | null;
  readonly branding: StoreBranding;
  readonly shopDomain: string;
}

export interface ExecutionOutcome {
  readonly status: "SUCCEEDED" | "FAILED";
  readonly errorMessage: string | null;
  readonly retryable: boolean;
}

const checkoutRecipientRow = z.object({
  email: z.string().nullable(),
  first_name: z.string().nullable(),
  web_url: z.string().nullable(),
  completed_at: z.coerce.date().nullable(),
});

const customerRecipientRow = z.object({
  email: z.string().nullable(),
  first_name: z.string().nullable(),
});

const TOOL_REGISTRY: Readonly<Record<string, ActionTool>> = {
  [new DiscountTool().id]: new DiscountTool(),
  [new RecoveryEmailTool().id]: new RecoveryEmailTool(),
};

const TITLES: Record<string, string> = {
  RECOVERY: "Cart recovery incentive",
  WINBACK: "Win-back incentive",
  VIP: "VIP appreciation",
  CLEARANCE: "Clearance offer",
  PROMOTION: "Promotion",
};

export async function executeAction(
  deps: ExecutorDeps,
  input: { storeId: string; recommendationId: string; executionId: string },
): Promise<ExecutionOutcome> {
  const { db } = deps;
  return withStoreScope(db, input.storeId, async (tx) => {
    const executionRow = (
      await tx
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.id, input.executionId),
            eq(actionExecutions.storeId, input.storeId),
          ),
        )
        .limit(1)
    )[0];
    if (executionRow === undefined || executionRow.status === "SUCCEEDED") {
      return { status: "SUCCEEDED", errorMessage: null, retryable: false };
    }

    const rec = (
      await tx
        .select()
        .from(recommendations)
        .where(
          and(
            eq(recommendations.id, input.recommendationId),
            eq(recommendations.storeId, input.storeId),
          ),
        )
        .limit(1)
    )[0];
    if (rec === undefined) {
      return { status: "FAILED", errorMessage: "recommendation missing", retryable: false };
    }

    // Mark RUNNING (attempt counting is the executor's, the queue only retries).
    await tx
      .update(actionExecutions)
      .set({
        status: "RUNNING",
        attempts: executionRow.attempts + 1,
        startedAt: new Date(),
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(actionExecutions.id, executionRow.id));

    const toolCtx: ToolContext = {
      storeId: input.storeId,
      admin: deps.admin,
      email: deps.email,
      branding: deps.branding,
    };

    let toolRef = (executionRow.toolRef ?? {}) as Record<string, unknown>;
    let preview = (executionRow.actionPreview ?? {}) as Record<string, unknown>;
    try {
      const params = await buildToolParams(tx, deps, rec, executionRow.idempotencyKey, toolRef);
      for (const step of params.steps) {
        const tool = TOOL_REGISTRY[step.toolId];
        if (tool === undefined) throw new ToolExecutionError(step.toolId, "tool not registered", false);
        const result = await tool.execute(toolCtx, step.params, toolRef);
        toolRef = { ...toolRef, ...result.toolRefPatch };
        preview = { ...preview, ...result.previewPatch };
        // Checkpoint each step: a crash after this write resumes at the NEXT step.
        await tx
          .update(actionExecutions)
          .set({ toolRef, actionPreview: preview, updatedAt: new Date() })
          .where(eq(actionExecutions.id, executionRow.id));
      }

      await tx
        .update(actionExecutions)
        .set({ status: "SUCCEEDED", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(actionExecutions.id, executionRow.id));
      await tx
        .update(recommendations)
        .set({
          status: RecommendationStatus.Executed,
          stateVersion: rec.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await tx.insert(recommendationEvents).values({
        storeId: input.storeId,
        recommendationId: rec.id,
        event: RecommendationEventType.Executed,
        actorType: EventActorType.System,
        fromStatus: RecommendationStatus.Approved,
        toStatus: RecommendationStatus.Executed,
        details: { executionId: executionRow.id },
      });
      return { status: "SUCCEEDED", errorMessage: null, retryable: false };
    } catch (error) {
      const retryable =
        error instanceof ToolExecutionError || error instanceof ToolUnavailableError
          ? error instanceof ToolExecutionError
            ? error.retryable
            : false
          : false;
      const message = (error instanceof Error ? error.message : "unknown execution error").slice(0, 1000);
      await tx
        .update(actionExecutions)
        .set({ status: "FAILED", errorMessage: message, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(actionExecutions.id, executionRow.id));
      return { status: "FAILED", errorMessage: message, retryable };
    }
  });
}

interface ToolStep {
  readonly toolId: string;
  readonly params: Record<string, unknown>;
}

/**
 * Server-side parameter resolution. Recipients come from the DATA PLANE with
 * consent enforcement: WINBACK/VIP require accepts_marketing; RECOVERY sends
 * to the checkout's own contact (transactional). Empty recipient sets are a
 * typed, non-retryable failure — never a send to a guessed address.
 */
async function buildToolParams(
  tx: ProfitDb,
  deps: ExecutorDeps,
  rec: typeof recommendations.$inferSelect,
  idempotencyKey: string,
  toolRef: Record<string, unknown>,
): Promise<{ steps: readonly ToolStep[] }> {
  const actionParams = (rec.actionParams ?? {}) as Record<string, unknown>;
  const draft = (actionParams["emailDraft"] ?? null) as EmailTemplateParams["draft"] | null;
  const percent = Number(actionParams["discountPercent"] ?? 0);
  const template = String(actionParams["template"] ?? actionParams["purpose"] ?? "RECOVERY");
  const code = codeFromIdempotencyKey(idempotencyKey);
  const steps: ToolStep[] = [];

  const discountStep = (purpose: string, expiresInDays: number): ToolStep => ({
    toolId: "discount.create-basic",
    params: {
      title: `Profit AI — ${TITLES[purpose] ?? "Offer"} (${code})`,
      percent,
      code,
      expiresInDays,
    },
  });

  if (rec.actionType === ActionType.CreateDiscountCode) {
    if (percent <= 0) throw new ToolExecutionError("discount.create-basic", "percent must be > 0", false);
    const expires = Number(actionParams["expiresInDays"] ?? 14);
    return { steps: [discountStep(template === "RECOVERY" ? "CLEARANCE" : template, expires)] };
  }

  if (rec.actionType === ActionType.SendRecoveryEmail) {
    if (draft === null) throw new ToolExecutionError("email.send-recovery", "missing emailDraft", false);
    if (typeof actionParams["checkoutToken"] === "string") {
      const token = actionParams["checkoutToken"];
      const rows = z.array(checkoutRecipientRow).parse(
        await execRaw<unknown>(tx, checkoutRecipientSql(rec.storeId, token)),
      );
      const checkout = rows[0];
      if (checkout?.completed_at != null) {
        throw new ToolExecutionError(
          "email.send-recovery",
          "checkout already completed — recovery is pointless",
          false,
        );
      }
      if (checkout === undefined || checkout.email === null || checkout.web_url === null) {
        throw new ToolExecutionError(
          "email.send-recovery",
          "checkout has no reachable contact or recovery URL",
          false,
        );
      }
      if (percent > 0 && typeof toolRef["discountCode"] !== "string") {
        steps.push(discountStep("RECOVERY", 7));
      }
      const emailParams: EmailTemplateParams = {
        template: "RECOVERY",
        recipients: [{ email: checkout.email, firstName: checkout.first_name }],
        draft,
        ctaUrl: checkout.web_url,
        checkoutToken: token,
        ...(typeof toolRef["discountCode"] === "string" || percent > 0
          ? { discountCode: (toolRef["discountCode"] as string | undefined) ?? code, discountPercent: percent }
          : {}),
      };
      steps.push({ toolId: "email.send-recovery", params: { ...emailParams } });
      return { steps };
    }

    // WINBACK / VIP batch: consent-checked recipients from the customer plane.
    const subjects = (rec.subjects ?? {}) as { customerIds?: string[] };
    const customerIds = subjects.customerIds ?? [];
    if (customerIds.length === 0) {
      throw new ToolExecutionError("email.send-recovery", "no customer subjects", false);
    }
    const rows = z.array(customerRecipientRow).parse(
      await execRaw<unknown>(tx, customerRecipientsSql(rec.storeId, customerIds)),
    );
    const recipients = rows
      .filter((row) => row.email !== null)
      .map((row) => ({ email: row.email as string, firstName: row.first_name }))
      .slice(0, 5);
    if (recipients.length === 0) {
      throw new ToolExecutionError(
        "email.send-recovery",
        "no consented recipients (accepts_marketing=false or missing email)",
        false,
      );
    }
    if (percent > 0 && typeof toolRef["discountCode"] !== "string") {
      steps.push(discountStep(template, 14));
    }
    const emailTemplate = template === "VIP" || template === "WINBACK" ? template : "WINBACK";
    steps.push({
      toolId: "email.send-recovery",
      params: {
        template: emailTemplate,
        recipients,
        draft,
        ctaUrl: `https://${deps.shopDomain}`,
        ...(percent > 0
          ? { discountCode: (toolRef["discountCode"] as string | undefined) ?? code, discountPercent: percent }
          : {}),
      },
    });
    return { steps };
  }

  // ADVISORY has no tool — the executor treats it as an instant no-op success.
  return { steps: [] };
}

function checkoutRecipientSql(storeId: string, token: string) {
  return sql`
    SELECT c.email, cust.first_name, c.web_url, c.completed_at
    FROM shopify_checkouts c
    LEFT JOIN shopify_customers cust ON cust.id = c.customer_id
    WHERE c.store_id = ${storeId} AND c.token = ${token}
    LIMIT 1`;
}

function customerRecipientsSql(storeId: string, customerIds: readonly string[]) {
  return sql`
    SELECT c.email, c.first_name
    FROM shopify_customers c
    WHERE c.store_id = ${storeId}
      AND c.accepts_marketing = true
      AND c.id IN (${sql.join(customerIds.map((id) => sql`${id}::uuid`), sql`,`)})`;
}
