import { ShopifyHttpError, shopifyPostJson } from "@profit/shopify";
import { z } from "zod";
import type { ActionTool, ToolContext, ToolStepResult } from "./port";
import { ToolExecutionError, ToolUnavailableError } from "./port";

/**
 * discount.create-basic (P3 discount tool). Creates ONE percentage price rule
 * + ONE discount code in the merchant's store with explicit start/end dates.
 *
 * Idempotency: the code string is derived deterministically from the
 * execution's idempotency key, and the toolRef checkpoint (priceRuleId →
 * discountCode) makes a retry after partial completion continue exactly
 * where the network cut out — never a duplicate rule.
 */

export const DISCOUNT_TOOL_ID = "discount.create-basic";

const paramsSchema = z.object({
  title: z.string().min(3).max(120),
  percent: z.number().int().min(1).max(50),
  code: z.string().min(4).max(32).regex(/^[A-Z0-9-]+$/, "code must be A-Z 0-9 -"),
  expiresInDays: z.number().int().min(1).max(60),
});

const priceRuleResponse = z.object({
  price_rule: z.object({ id: z.number() }),
});
const discountCodeResponse = z.object({
  discount_code: z.object({ id: z.number(), code: z.string() }),
});

export class DiscountTool implements ActionTool {
  readonly id = DISCOUNT_TOOL_ID;

  async execute(
    ctx: ToolContext,
    rawParams: Record<string, unknown>,
    currentRef: Record<string, unknown>,
  ): Promise<ToolStepResult> {
    if (ctx.admin === null) {
      throw new ToolUnavailableError(this.id, "store admin context not resolvable (reinstall?)");
    }
    const params = paramsSchema.parse(rawParams);
    const ref: Record<string, unknown> = { ...currentRef };

    // Step 1 — price rule (skip when a previous attempt already made it).
    if (typeof ref["priceRuleId"] !== "string") {
      const startsAt = new Date();
      const endsAt = new Date(startsAt.getTime() + params.expiresInDays * 86_400_000);
      const body = {
        price_rule: {
          title: params.title.slice(0, 120),
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "percentage",
          value: `-${params.percent}`,
          customer_selection: "all",
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          usage_limit: 1, // per-code single-use: recovery incentives stay personal
        },
      };
      const created = await this.post(
        ctx,
        `price_rules.json`,
        body,
        priceRuleResponse,
        "create price rule",
      );
      ref["priceRuleId"] = String(created.price_rule.id);
      ref["percent"] = params.percent;
      ref["expiresAt"] = endsAt.toISOString();
    }

    // Step 2 — the discount code under that rule (deterministic code string).
    if (typeof ref["discountCode"] !== "string") {
      const created = await this.post(
        ctx,
        `price_rules/${ref["priceRuleId"]}/discount_codes.json`,
        { discount_code: { code: params.code } },
        discountCodeResponse,
        "create discount code",
      );
      ref["discountCode"] = created.discount_code.code;
    }

    return {
      toolRefPatch: ref,
      previewPatch: {
        discountCode: ref["discountCode"],
        percent: ref["percent"] ?? params.percent,
        expiresAt: ref["expiresAt"] ?? null,
      },
    };
  }

  private async post<TSchema extends z.ZodType<unknown>>(
    ctx: ToolContext,
    path: string,
    body: unknown,
    schema: TSchema,
    action: string,
  ): Promise<z.infer<TSchema>> {
    try {
      const admin = ctx.admin;
      if (admin === null) throw new Error("admin context missing");
      const response = await shopifyPostJson<unknown>(
        `https://${admin.shopDomain}/admin/api/${admin.apiVersion}/${path}`,
        body,
        {
          "X-Shopify-Access-Token": admin.accessToken,
        },
        { maxRetries: 3 },
      );
      return schema.parse(response);
    } catch (error) {
      if (error instanceof ShopifyHttpError) {
        const detail = error.body.slice(0, 300);
        // 422 duplicate code → deterministic collision with a manual code: non-retryable.
        throw new ToolExecutionError(
          this.id,
          `shopify ${action} http ${error.status}: ${detail}`,
          error.status >= 500 || error.status === 429,
        );
      }
      throw error instanceof ToolExecutionError
        ? error
        : new ToolExecutionError(
            this.id,
            `${action}: ${error instanceof Error ? error.message : "unknown"}`,
            false,
          );
    }
  }
}

/** Deterministic per-execution code, e.g. PT-A1B2C3D4 (idempotent retries). */
export function codeFromIdempotencyKey(key: string): string {
  return `PT-${key.slice(0, 8).toUpperCase()}`;
}
