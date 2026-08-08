import { buildPdfDocument, type PdfDocumentInput } from "@profit/automation";
import type { ReportSectionsData } from "./sections";

/**
 * Sections → PDF mapping (ADR 34): the SAME deterministic structure drives
 * the JSON payload, the executive prose and this printable — one source.
 */

export function reportPdfInput(data: ReportSectionsData, executiveSummary: string): PdfDocumentInput {
  const kindTitle = `${data.kind.charAt(0)}${data.kind.slice(1).toLowerCase()} Report`;
  return {
    title: `${data.storeName} — ${kindTitle}`,
    subtitle: `${data.periodLabel} · Generated ${data.generatedAt.slice(0, 10)} by PROFIT TOOL AI`,
    sections: [
      {
        heading: "Executive summary",
        paragraphs: [executiveSummary],
        table: null,
      },
      {
        heading: "Key performance indicators",
        paragraphs: [],
        table: {
          headers: ["Metric", "Value", "Δ vs prior"],
          rows: data.kpis.map((kpi) => [
            kpi.label,
            kpi.display,
            kpi.deltaPct === null || kpi.deltaPct === undefined ? "—" : `${kpi.deltaPct > 0 ? "+" : ""}${kpi.deltaPct}%`,
          ]),
        },
      },
      {
        heading: data.performance.title,
        paragraphs: [],
        table: {
          headers: [...data.performance.columns],
          rows: data.performance.rows,
        },
      },
      ...(data.topProducts !== null
        ? [{
            heading: data.topProducts.title,
            paragraphs: [] as readonly string[],
            table: {
              headers: [...data.topProducts.columns],
              rows: data.topProducts.rows,
            },
          }]
        : []),
      {
        heading: "Outlook & watchlist",
        paragraphs: [...data.highlights],
        table: null,
      },
      {
        heading: "Trust",
        paragraphs: [
          `Method note: KPIs derive from the same analytics read model as the merchant dashboard (window ${data.period.startIso} → ${data.period.endIsoExclusive}, exclusive); the outlook is method-stamped ${data.forecast?.method ?? "pending-history"} — never model-invented.`,
          `Ledger: ${data.actions.createdInPeriod} actions created, ${data.actions.executedInPeriod} executed this period, ${data.actions.openPendingAtEnd} awaiting review.`,
        ],
        table: null,
      },
    ],
  };
}

export function buildReportPdf(data: ReportSectionsData, executiveSummary: string): Buffer {
  return buildPdfDocument(reportPdfInput(data, executiveSummary));
}

/** Download-safe filename (ASCII, no spaces). */
export function reportFilename(input: { storeName: string; kind: string; startIso: string }): string {
  const store = input.storeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "store";
  return `${store}-${input.kind.toLowerCase()}-${input.startIso}.pdf`;
}
