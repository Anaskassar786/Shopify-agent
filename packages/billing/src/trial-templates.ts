import type { TransactionalEmail } from "./ports";

/**
 * Trial journey copy (P11 D0–D3). Every figure in the subject/body is a real
 * engine number passed in by the caller — templates contain zero invented
 * content. M6's Email Center adapts these into the template registry; the
 * copy contract here stays source-of-truth until then.
 */

export interface TrialNudgeFacts {
  readonly shopName: string;
  readonly day: 1 | 2 | 3;
  /** Open (awaiting decision) recommendations right now. */
  readonly openRecommendations: number;
  /** Sum of deterministic estimated revenue across open recommendations. */
  readonly openEstimatedRevenueCents: number;
  /** Already-attributed recovered revenue (0 for most trialing stores). */
  readonly attributedRevenueCents: number;
  /** Trial days remaining after today (0 on the last day). */
  readonly daysRemaining: number;
  /** Deep link into the app (Shopify admin app path). */
  readonly appUrl: string;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function renderTrialNudge(facts: TrialNudgeFacts): Pick<
  TransactionalEmail,
  "subject" | "textBody" | "htmlBody"
> {
  const recovered = money(facts.attributedRevenueCents);
  const potential = money(facts.openEstimatedRevenueCents);
  const openCount = facts.openRecommendations;

  const subjectByDay: Record<1 | 2 | 3, string> = {
    1:
      openCount > 0
        ? `Your store has ${String(openCount)} open opportunit${openCount === 1 ? "y" : "ies"}`
        : "Your AI analysis is ready to explore",
    2:
      facts.openEstimatedRevenueCents > 0
        ? `AI found a potential ${potential} recovery opportunity`
        : "Your AI opportunities update",
    3: `${facts.shopName}: your free trial ends ${facts.daysRemaining === 0 ? "today" : "tomorrow"}`,
  };
  const subject = subjectByDay[facts.day];

  const bodyLines = [
    `Hi ${facts.shopName} team,`,
    "",
    ...(facts.day === 1
      ? [
          openCount > 0
            ? `The engine finished analyzing your store and has ${String(openCount)} recommendation${openCount === 1 ? "" : "s"} waiting for your review — each with evidence and a revenue estimate.`
            : "The engine is analyzing your store. Recommendations land with evidence and revenue estimates — nothing runs without your approval.",
        ]
      : []),
    ...(facts.day === 2
      ? [
          facts.openEstimatedRevenueCents > 0
            ? `Open recommendations carry a combined estimated upside of ${potential} (deterministic estimates from your store data — never model-written).`
            : "Your engine keeps scanning. When it finds an opportunity you'll see the estimate with its evidence.",
          facts.attributedRevenueCents > 0
            ? `So far, approved actions recovered ${recovered}.`
            : "Approve your first recommendation to start measuring recovered revenue.",
        ]
      : []),
    ...(facts.day === 3
      ? [
          `Your free trial ${facts.daysRemaining === 0 ? "ends today" : "ends tomorrow"}.`,
          "Upgrade to keep the engine running — recommendations, automation and attribution measurement continue without interruption. Billing is handled securely by Shopify.",
        ]
      : []),
    "",
    `Review now: ${facts.appUrl}`,
    "",
    "— PROFIT TOOL AI",
  ];
  const textBody = bodyLines.join("\n");

  const htmlBody = `<!doctype html>
<html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;">
  <div style="max-width:560px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.12em;color:#7d8590;text-transform:uppercase;">Profit Tool AI · trial day ${String(
      facts.day,
    )}</p>
    <h1 style="margin:0 0 16px;font-size:20px;color:#f0f6fc;">${escapeHtmlText(subject)}</h1>
    <div style="font-size:14px;line-height:1.6;color:#c9d1d9;white-space:pre-line;">${escapeHtmlText(
      bodyLines.slice(1, -3).join("\n"),
    )}</div>
    <a href="${facts.appUrl}" style="display:inline-block;margin-top:20px;background:#2f81f7;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">Open Profit Tool AI</a>
    <p style="margin:24px 0 0;font-size:12px;color:#7d8590;">You received this because your store installed PROFIT TOOL AI. Manage billing in Shopify Admin.</p>
  </div>
</body></html>`;

  return { subject, textBody, htmlBody };
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
