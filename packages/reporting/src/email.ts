import type { ReportSectionsData } from "./sections";

/**
 * Report email rendering (ADR 34): the EmailSender port carries text+HTML
 * only (no attachments), so the email is the executive summary + KPI table
 * with the in-app path to the PDF — the full document always lives in the
 * reports vault behind permissions.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderReportEmail(data: ReportSectionsData, executiveSummary: string): {
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const kindWord = data.kind.toLowerCase();
  const subject = `${data.storeName} ${kindWord} report — ${data.periodLabel}`;
  const kpiLines = data.kpis.map(
    (kpi) =>
      `• ${kpi.label}: ${kpi.display}${
        kpi.deltaPct === null || kpi.deltaPct === undefined ? "" : ` (${kpi.deltaPct > 0 ? "+" : ""}${kpi.deltaPct}% vs prior)`
      }`,
  );
  const textBody = [
    `${data.storeName} — ${kindWord} report for ${data.periodLabel}`,
    "",
    executiveSummary,
    "",
    ...kpiLines,
    "",
    ...data.highlights.map((line) => `• ${line}`),
    "",
    "Open PROFIT TOOL AI → Reports to read the full report and download the PDF.",
  ].join("\n");

  const kpiRows = data.kpis
    .map(
      (kpi) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${escapeHtml(kpi.label)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(kpi.display)}</td><td style="padding:4px 0 4px 12px;color:${kpi.deltaPct !== null && kpi.deltaPct !== undefined && kpi.deltaPct < 0 ? "#b3261e" : "#1e7e34"}">${
          kpi.deltaPct === null || kpi.deltaPct === undefined ? "" : escapeHtml(`${kpi.deltaPct > 0 ? "+" : ""}${kpi.deltaPct}%`)
        }</td></tr>`,
    )
    .join("");
  const highlightItems = data.highlights
    .map((line) => `<li style="margin:4px 0">${escapeHtml(line)}</li>`)
    .join("");
  const htmlBody = `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
  <h2 style="margin:0 0 8px">${escapeHtml(data.storeName)} — ${kindWord} report</h2>
  <p style="margin:0 0 16px;color:#555">${escapeHtml(data.periodLabel)}</p>
  <p style="line-height:1.55">${escapeHtml(executiveSummary)}</p>
  <table style="border-collapse:collapse;margin:12px 0">${kpiRows}</table>
  <ul style="padding-left:18px;color:#333">${highlightItems}</ul>
  <p style="margin-top:20px;color:#555">Open <strong>PROFIT TOOL AI → Reports</strong> to read the full report and download the PDF.</p>
</div>`;
  return { subject, textBody, htmlBody };
}
