import { z } from "zod";
import type { ActionTool, ToolContext, ToolStepResult } from "./port";
import { ToolExecutionError, ToolUnavailableError, type StoreBranding } from "./port";

/**
 * email.send-recovery (P3 email content + automation). Renders AI-drafted
 * copy into the store-branded, escaped template and sends it through the
 * platform email port.
 *
 * Template variants are TOOL parameters, not AI choices:
 *   RECOVERY — one abandoned checkout (transactional: cart belongs to recipient)
 *   WINBACK  — lapsed customers (requires accepts_marketing on the customer row)
 *   VIP      — top-LTV appreciation (requires accepts_marketing)
 *
 * HTML construction escapes every dynamic string at the boundary — model
 * copy can never inject markup (XSS-safe by construction).
 */

export const EMAIL_TOOL_ID = "email.send-recovery";

export const emailTemplateParamsSchema = z.object({
  template: z.enum(["RECOVERY", "WINBACK", "VIP"]),
  recipients: z
    .array(
      z.object({
        email: z.string().email(),
        firstName: z.string().max(120).nullable(),
      }),
    )
    .min(1)
    .max(5),
  draft: z.object({
    subject: z.string().min(5).max(120),
    body: z.string().min(20).max(1_500),
    ctaLabel: z.string().min(2).max(40),
  }),
  ctaUrl: z.string().url().max(1024),
  checkoutToken: z.string().max(128).optional(),
  discountCode: z.string().max(32).optional(),
  discountPercent: z.number().int().min(0).max(50).optional(),
});

export type EmailTemplateParams = z.infer<typeof emailTemplateParamsSchema>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface BrandedEmail {
  readonly html: string;
  readonly text: string;
}

export function renderBrandedEmail(
  branding: StoreBranding,
  params: EmailTemplateParams,
  recipientFirstName: string | null,
): BrandedEmail {
  const accent = branding.primaryColor ?? "#6366f1";
  const storeName = escapeHtml(branding.storeName);
  const subject = escapeHtml(params.draft.subject);
  // Greeting is server-side deterministic (prompts are instructed to omit it).
  const greeting = `Hi ${escapeHtml(recipientFirstName ?? "there")},`;
  const greetingText = `Hi ${recipientFirstName ?? "there"},`;
  const paragraphs = params.draft.body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const discountNote =
    params.discountCode !== undefined && (params.discountPercent ?? 0) > 0
      ? `<p style="margin:16px 0;padding:12px 16px;border:1px dashed ${escapeHtml(accent)};border-radius:8px;text-align:center;">
          Use code <strong>${escapeHtml(params.discountCode)}</strong> for ${params.discountPercent}% off (limited time).
        </p>`
      : "";
  const logo =
    branding.logoUrl !== null
      ? `<img src="${escapeHtml(branding.logoUrl)}" alt="${storeName}" style="max-height:40px;margin-bottom:16px;" />`
      : `<div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:16px;">${storeName}</div>`;
  const bodyHtml = paragraphs
    .map((paragraph) => `<p style="margin:0 0 14px;line-height:1.55;">${escapeHtml(paragraph)}</p>`)
    .join("");
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border-radius:12px;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
      ${logo}
      <h1 style="font-size:18px;margin:0 0 18px;color:#111827;">${subject}</h1>
      <p style="margin:0 0 14px;line-height:1.55;">${greeting}</p>
      ${bodyHtml}
      ${discountNote}
      <p style="text-align:center;margin:22px 0 6px;">
        <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background:${escapeHtml(accent)};color:#ffffff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:600;">
          ${escapeHtml(params.draft.ctaLabel)}
        </a>
      </p>
      <p style="font-size:12px;color:#6b7280;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;">
        You received this email because you shopped at ${storeName}.${
          branding.supportEmail !== null
            ? ` Questions? Contact <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color:${escapeHtml(accent)};">${escapeHtml(branding.supportEmail)}</a>.`
            : ""
        }
      </p>
    </div>
  </div>
</body></html>`;
  const text = [
    params.draft.subject,
    "",
    greetingText,
    ...paragraphs,
    ...(params.discountCode !== undefined && (params.discountPercent ?? 0) > 0
      ? ["", `Use code ${params.discountCode} for ${params.discountPercent}% off (limited time).`]
      : []),
    "",
    `${params.draft.ctaLabel}: ${params.ctaUrl}`,
    "",
    `— ${branding.storeName}`,
  ].join("\n");
  return { html, text };
}

export class RecoveryEmailTool implements ActionTool {
  readonly id = EMAIL_TOOL_ID;

  async execute(
    ctx: ToolContext,
    rawParams: Record<string, unknown>,
    currentRef: Record<string, unknown>,
  ): Promise<ToolStepResult> {
    if (ctx.email === null) {
      throw new ToolUnavailableError(this.id, "SMTP not configured (SMTP_HOST/SMTP_USER missing)");
    }
    const params = emailTemplateParamsSchema.parse(rawParams);
    const sentTo: string[] = [...((currentRef["sentTo"] as readonly string[] | undefined) ?? [])];
    const messageIds: Record<string, string | null> = {
      ...((currentRef["messageIds"] as Record<string, string | null> | undefined) ?? {}),
    };

    for (const recipient of params.recipients) {
      if (sentTo.includes(recipient.email)) continue; // retry checkpoint — never double-send
      try {
        const rendered = renderBrandedEmail(ctx.branding, params, recipient.firstName);
        const result = await ctx.email.send({
          to: recipient.email,
          subject: params.draft.subject,
          htmlBody: rendered.html,
          textBody: rendered.text,
        });
        sentTo.push(recipient.email);
        messageIds[recipient.email] = result.messageId;
      } catch (error) {
        throw new ToolExecutionError(
          this.id,
          `send to ${recipient.email}: ${error instanceof Error ? error.message : "unknown"}`,
          true, // SMTP failures are transient; the queue retries with checkpoints
        );
      }
    }
    return {
      toolRefPatch: { ...currentRef, sentTo, messageIds },
      previewPatch: { recipients: sentTo, template: params.template },
    };
  }
}
