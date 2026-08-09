import nodemailer, { type Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";
import type { EmailSendInput, EmailSender } from "./port";

/**
 * SMTP EmailSender (production adapter for the email port). Built on
 * nodemailer — hand-rolled SMTP (STARTTLS negotiation, AUTH mechanisms,
 * connection pooling) is a security minefield we deliberately do not own.
 *
 * The sender is constructed ONLY when the full credential set exists; the
 * composition root otherwise injects null and the tool reports itself
 * unavailable (failsafe, never a silent no-op).
 */

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly fromAddress: string;
  readonly fromName?: string;
}

/**
 * Transport factory — injectable like GeminiProvider.fetchImpl so the
 * network edge stays the only stubbed boundary in tests (and so a local
 * debug transport can be wired without touching this class).
 */
export type SmtpTransportFactory = (
  options: SMTPPool.Options,
) => Transporter;

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig, createTransport: SmtpTransportFactory = nodemailer.createTransport) {
    this.from =
      config.fromName !== undefined
        ? `"${config.fromName}" <${config.fromAddress}>`
        : config.fromAddress;
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465, // implicit TLS on 465; STARTTLS otherwise
      auth: { user: config.user, pass: config.password },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async send(input: EmailSendInput): Promise<{ readonly messageId: string | null }> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.textBody,
      html: input.htmlBody,
    });
    const messageId = typeof info.messageId === "string" ? info.messageId : null;
    return { messageId };
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
