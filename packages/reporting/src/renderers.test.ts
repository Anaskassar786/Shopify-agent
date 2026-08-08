import { describe, expect, it } from "vitest";
import { ReportKind } from "@profit/types";
import { renderReportEmail } from "./email";
import { buildReportPdf, reportFilename } from "./pdf";
import type { ReportSectionsData } from "./sections";

function makeSections(overrides: Partial<ReportSectionsData> = {}): ReportSectionsData {
  return {
    storeName: "Demo <Store>",
    currency: "USD",
    kind: ReportKind.Weekly,
    periodLabel: "Jul 27, 2026 – Aug 2, 2026",
    period: { startIso: "2026-07-27", endIsoExclusive: "2026-08-03" },
    generatedAt: "2026-08-08T09:00:00.000Z",
    headline: "Demo Store — weekly report · Jul 27, 2026 – Aug 2, 2026: net $1,750.00 (+8% vs prior)",
    kpis: [
      { label: "Net sales", display: "$1,750.00", deltaPct: 8 },
      { label: "Orders", display: "35", deltaPct: -2 },
    ],
    highlights: [
      "14-day outlook (revenue.weekly-seasonality.v1): $3,400.00 expected (range $3,100.00–$3,700.00).",
      "1 product faces stockout within the cover horizon.",
    ],
    performance: {
      title: "Daily performance",
      columns: ["Date", "Net sales", "Orders", "New customers"],
      rows: [["2026-08-02", "$250.00", "5", "1"]],
    },
    topProducts: {
      title: "Top products",
      columns: ["Product", "Revenue", "Units", "Δ vs prior"],
      rows: [["Copper Kettle", "$900.00", "18", "+12%"]],
    },
    forecast: {
      method: "revenue.weekly-seasonality.v1",
      horizonDays: 14,
      expectedCents: 340_000,
      lowCents: 310_000,
      highCents: 370_000,
      stockoutRisks: 1,
      churnRisks: 0,
    },
    actions: { createdInPeriod: 2, executedInPeriod: 1, openPendingAtEnd: 3 },
    ...overrides,
  };
}

describe("renderReportEmail", () => {
  it("carries subject, summary, KPI lines, highlights and the in-app PDF pointer", () => {
    const email = renderReportEmail(makeSections(), "The week held steady and recovered the holiday dip.");
    expect(email.subject).toBe("Demo <Store> weekly report — Jul 27, 2026 – Aug 2, 2026");
    expect(email.textBody).toContain("The week held steady");
    expect(email.textBody).toContain("• Net sales: $1,750.00 (+8% vs prior)");
    expect(email.textBody).toContain("• Orders: 35 (-2% vs prior)");
    expect(email.textBody).toContain("Reports");
    expect(email.htmlBody).toContain("<strong>PROFIT TOOL AI → Reports</strong>");
  });

  it("escapes HTML in every interpolated field", () => {
    const email = renderReportEmail(makeSections(), "Summary with <script>alert(1)</script> inside.");
    expect(email.htmlBody).not.toContain("<script>");
    expect(email.htmlBody).toContain("&lt;script&gt;");
    expect(email.htmlBody).toContain("Demo &lt;Store&gt;");
  });
});

describe("buildReportPdf + reportFilename", () => {
  it("emits a valid multi-section PDF from the same sections structure", () => {
    const pdf = buildReportPdf(makeSections(), "Executive summary paragraph here.");
    expect(pdf.slice(0, 8).toString("latin1")).toBe("%PDF-1.4");
    const text = pdf.toString("latin1");
    expect(text).toContain("(Executive summary)");
    expect(text).toContain("(Key performance indicators)");
    expect(text).toContain("(Daily performance)");
    expect(text).toContain("(Top products)");
    expect(text).toContain("(Outlook & watchlist)");
    expect(text).toContain("revenue.weekly-seasonality.v1");
  });

  it("deterministic for identical input (fixture-stable PDFs)", () => {
    const sections = makeSections();
    expect(buildReportPdf(sections, "s").equals(buildReportPdf(sections, "s"))).toBe(true);
  });

  it("filename is ASCII-safe and period-anchored", () => {
    expect(reportFilename({ storeName: "Café Müller & Co", kind: "WEEKLY", startIso: "2026-07-27" })).toBe(
      "caf-m-ller-co-weekly-2026-07-27.pdf",
    );
    expect(reportFilename({ storeName: "!!!", kind: "DAILY", startIso: "2026-08-07" })).toBe(
      "store-daily-2026-08-07.pdf",
    );
  });
});
