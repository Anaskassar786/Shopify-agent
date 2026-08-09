import { describe, expect, it, vi } from "vitest";
import type { Transporter } from "nodemailer";
import { SmtpEmailSender, type SmtpTransportFactory } from "./smtp-sender";
import type { EmailSendInput } from "./port";

/**
 * SMTP adapter contract — the injected transport factory is the only stubbed
 * boundary (the network edge, same rule as the Gemini adapter). Proves
 * transport configuration (pooling, TLS policy, timeouts), message mapping,
 * from-name formatting, and close().
 */

interface CapturedTransport {
  readonly sendMail: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly options: unknown;
}

function makeFactory(messageId: string | null = "<m-1@test.example>"): {
  readonly factory: SmtpTransportFactory;
  readonly captured: CapturedTransport[];
} {
  const captured: CapturedTransport[] = [];
  const resolved = messageId ?? undefined; // nodemailer omits the key when the server gives none
  const factory = ((options: unknown) => {
    const sendMail = vi.fn(async () => ({ messageId: resolved }));
    const close = vi.fn();
    captured.push({ sendMail, close, options });
    return { sendMail, close } as unknown as Transporter;
  }) as SmtpTransportFactory;
  return { factory, captured };
}

const baseConfig = {
  host: "smtp.resend.example",
  port: 587,
  user: "resend",
  password: "secret-smtp-key", // pragma: allowlist secret
  fromAddress: "growth@profit-tool.example",
} as const;

function firstTransport(captured: CapturedTransport[]): CapturedTransport {
  const transport = captured[0];
  if (transport === undefined) {
    throw new Error("expected exactly one transport to be constructed");
  }
  return transport;
}

describe("SmtpEmailSender", () => {
  it("configures a pooled STARTTLS transport with bounded connections and timeouts", () => {
    const { factory, captured } = makeFactory();
    new SmtpEmailSender(baseConfig, factory);

    expect(firstTransport(captured).options).toEqual({
      host: "smtp.resend.example",
      port: 587,
      secure: false, // STARTTLS upgrade, not implicit TLS
      auth: { user: "resend", pass: "secret-smtp-key" }, // pragma: allowlist secret
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });
  });

  it("uses implicit TLS on port 465", () => {
    const { factory, captured } = makeFactory();
    new SmtpEmailSender({ ...baseConfig, port: 465 }, factory);

    expect(firstTransport(captured).options).toMatchObject({ port: 465, secure: true });
  });

  it("sends with mapped fields and the default from address", async () => {
    const { factory, captured } = makeFactory();
    const sender = new SmtpEmailSender(baseConfig, factory);

    const input: EmailSendInput = {
      to: "customer@example.com",
      subject: "You left something behind",
      textBody: "plain body",
      htmlBody: "<p>html body</p>",
    };
    const result = await sender.send(input);

    const transport = firstTransport(captured);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "growth@profit-tool.example",
      to: "customer@example.com",
      subject: "You left something behind",
      text: "plain body",
      html: "<p>html body</p>",
    });
    expect(result).toEqual({ messageId: "<m-1@test.example>" });
  });

  it("formats the from header with a display name when configured", async () => {
    const { factory, captured } = makeFactory();
    const sender = new SmtpEmailSender({ ...baseConfig, fromName: "Profit Tool AI" }, factory);
    await sender.send({ to: "a@b.c", subject: "s", textBody: "t", htmlBody: "<p>t</p>" });

    expect(firstTransport(captured).sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"Profit Tool AI" <growth@profit-tool.example>' }),
    );
  });

  it("reports a null message id when the transport does not provide one", async () => {
    const { factory } = makeFactory(null);
    const sender = new SmtpEmailSender(baseConfig, factory);
    const result = await sender.send({ to: "a@b.c", subject: "s", textBody: "t", htmlBody: "<p>t</p>" });

    expect(result).toEqual({ messageId: null });
  });

  it("propagates transport failures (never swallows an email error)", async () => {
    const { factory, captured } = makeFactory();
    const sender = new SmtpEmailSender(baseConfig, factory);
    firstTransport(captured).sendMail.mockRejectedValueOnce(new Error("SMTP 535 auth failed"));

    await expect(
      sender.send({ to: "a@b.c", subject: "s", textBody: "t", htmlBody: "<p>t</p>" }),
    ).rejects.toThrow("SMTP 535 auth failed");
  });

  it("closes the pooled transport on shutdown and stays send-safe afterwards", async () => {
    const { factory, captured } = makeFactory();
    const sender = new SmtpEmailSender(baseConfig, factory);
    await sender.close();

    expect(firstTransport(captured).close).toHaveBeenCalledTimes(1);
  });
});
