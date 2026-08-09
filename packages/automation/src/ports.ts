/**
 * M6 injection ports (P1: modules never self-construct). The worker's
 * composition root satisfies these from real drivers — SmtpEmailSender
 * (M4, structurally identical), TwilioSmsSender, and the Shopify offline
 * admin context. Business logic never imports a concrete provider.
 */

export interface MessageEmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

export interface MessageEmailSender {
  send(input: MessageEmailSendInput): Promise<{ readonly messageId: string | null }>;
}

export interface SmsSendInput {
  /** E.164 destination. */
  readonly to: string;
  readonly body: string;
}

export interface SmsSender {
  send(input: SmsSendInput): Promise<{ readonly providerRef: string | null }>;
}

/**
 * Narrow Shopify write surface for workflow actions (customer tag update,
 * price-rule creation). Shaped on the Admin REST API paths the M4 discount
 * tool already proved; the worker adapts its offline-token context.
 */
export interface WorkflowAdminPort {
  postJson(path: string, body: unknown): Promise<unknown>;
  putJson(path: string, body: unknown): Promise<unknown>;
}

/** Send failure classification drives retry-vs-terminal decisions. */
export class MessageSendError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "MessageSendError";
    this.retryable = retryable;
  }
}

export class StoreBrandingLookupError extends Error {
  constructor(storeId: string) {
    super(`store ${storeId} not resolvable for messaging`);
    this.name = "StoreBrandingLookupError";
  }
}
