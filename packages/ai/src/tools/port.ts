import type { ShopifyAdminContext } from "@profit/shopify";

/**
 * Action tool port + registry (P3 automation engine, P10 tool-use pattern).
 * Tools are the ONLY way a recommendation produces an external side effect.
 * Every tool:
 *  - is idempotent (retries continue from persisted toolRef checkpoints);
 *  - receives a bounded, server-validated params object — model output never
 *    arrives unshaped;
 *  - returns refs the execution ledger persists for attribution + audit.
 */

export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export interface EmailSender {
  send(input: EmailSendInput): Promise<{ readonly messageId: string | null }>;
}

export interface StoreBranding {
  readonly storeName: string;
  readonly logoUrl: string | null;
  readonly primaryColor: string | null;
  readonly supportEmail: string | null;
}

export interface ToolContext {
  readonly storeId: string;
  /** Offline-token admin context; absent only if the store disconnected mid-flight. */
  readonly admin: ShopifyAdminContext | null;
  readonly email: EmailSender | null;
  readonly branding: StoreBranding;
}

export interface ToolStepResult {
  /** Merge into action_executions.tool_ref (checkpoint across retries). */
  readonly toolRefPatch: Record<string, unknown>;
  /** Merchant-facing "what happened" lines for the execution detail pane. */
  readonly previewPatch: Record<string, unknown>;
}

export class ToolUnavailableError extends Error {
  constructor(toolId: string, reason: string) {
    super(`tool "${toolId}" unavailable: ${reason}`);
    this.name = "ToolUnavailableError";
  }
}

export class ToolExecutionError extends Error {
  readonly retryable: boolean;
  constructor(toolId: string, message: string, retryable: boolean) {
    super(`tool "${toolId}" failed: ${message}`);
    this.name = "ToolExecutionError";
    this.retryable = retryable;
  }
}

export interface ActionTool {
  readonly id: string;
  execute(
    ctx: ToolContext,
    params: Record<string, unknown>,
    currentRef: Record<string, unknown>,
  ): Promise<ToolStepResult>;
}
