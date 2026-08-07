import { MessageSendError, type SmsSender, type SmsSendInput } from "./ports";

/**
 * Twilio Programmable Messaging adapter (M6). Raw HTTPS — no SDK: one POST,
 * Basic auth, a zod-free narrow response read, and failure classification
 * (4xx = terminal, 429/5xx = retryable). Constructed ONLY when the env trio
 * is present; the composition root injects null otherwise and every SMS
 * action fails closed with a clear reason (P3 failsafe).
 */

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly fromNumber: string;
}

export type TwilioFetch = typeof fetch;

const API_BASE = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 15_000;

interface TwilioMessageResponse {
  readonly sid?: string;
  readonly code?: number;
  readonly message?: string;
}

export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: TwilioFetch = fetch,
  ) {}

  async send(input: SmsSendInput): Promise<{ readonly providerRef: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${API_BASE}/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: input.to,
            From: this.config.fromNumber,
            Body: input.body,
          }).toString(),
          signal: controller.signal,
        },
      );
      const payload = (await response.json().catch(() => ({}))) as TwilioMessageResponse;
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const detail = payload.message ?? `HTTP ${response.status}`;
        throw new MessageSendError(`twilio: ${detail}`, retryable);
      }
      return { providerRef: typeof payload.sid === "string" ? payload.sid : null };
    } catch (error) {
      if (error instanceof MessageSendError) throw error;
      // Timeouts/DNS/TLS — retryable by nature.
      const reason = error instanceof Error ? error.message : "unknown";
      throw new MessageSendError(`twilio transport: ${reason}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
