import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportsPage } from "./ReportsPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import { storeResponse } from "../test-support/fixtures";
import type {
  ReportDetailDto,
  ReportEmailOutcomeDto,
  ReportGenerateResponseDto,
  ReportListItemDto,
} from "../lib/api-types";

/** M8 report vault (ADR 34): list, generate, PDF download, email, schedule. */

function reportRow(overrides: Partial<ReportListItemDto> = {}): ReportListItemDto {
  return {
    id: "rep-1",
    kind: "WEEKLY",
    status: "READY",
    periodLabel: "Aug 3–9, 2026",
    headline: "Net revenue $700.00 (+4.2% vs prior period)",
    executiveSummary: "Revenue held steady while two stockouts capped growth.",
    pdfSizeBytes: 12_345,
    lastEmailedOn: null,
    createdAt: "2026-08-09T00:05:00.000Z",
    completedAt: "2026-08-09T00:05:20.000Z",
    errorMessage: null,
    ...overrides,
  };
}

function reportDetail(): ReportDetailDto {
  return {
    ...reportRow(),
    sections: {
      storeName: "Moradabad Gems",
      currency: "USD",
      kind: "WEEKLY",
      periodLabel: "Aug 3–9, 2026",
      period: { startIso: "2026-08-03T00:00:00.000Z", endIsoExclusive: "2026-08-10T00:00:00.000Z" },
      generatedAt: "2026-08-09T00:05:20.000Z",
      headline: "Net revenue $700.00 (+4.2% vs prior period)",
      kpis: [
        { label: "Net revenue", display: "$700.00", deltaPct: 4.2 },
        { label: "Orders", display: "21", deltaPct: -3.1 },
      ],
      highlights: ["Brass Ladle drove 30% of net revenue"],
      performance: {
        title: "Period performance",
        columns: ["Metric", "This period", "Prior period"],
        rows: [["Net revenue", "$700.00", "$672.00"]],
      },
      topProducts: {
        title: "Top products",
        columns: ["Product", "Units", "Revenue"],
        rows: [["Brass Ladle", "9", "$210.00"]],
      },
      forecast: {
        method: "revenue.weekly-seasonality.v1",
        horizonDays: 14,
        expectedCents: 140_000,
        lowCents: 118_000,
        highCents: 162_000,
        stockoutRisks: 2,
        churnRisks: 4,
      },
      actions: { createdInPeriod: 5, executedInPeriod: 3, openPendingAtEnd: 2 },
    },
  };
}

function handlers(overrides: {
  readonly list?: ReportListItemDto[];
  readonly emailOutcome?: ReportEmailOutcomeDto;
} = {}): StubHandlers {
  return {
    get: {
      "/api/v1/store": () => storeResponse(),
      "/api/v1/reports": () => overrides.list ?? [reportRow()],
      "/api/v1/reports/rep-1": () => reportDetail(),
    },
    getWithMeta: {},
    post: {
      "/api/v1/reports/generate": (body) =>
        ({
          reportId: "rep-9",
          kind: (body as { kind: string }).kind as ReportGenerateResponseDto["kind"],
          periodLabel: "Jul 1–31, 2026",
          status: "READY",
          errorMessage: null,
        }) satisfies ReportGenerateResponseDto,
      "/api/v1/reports/rep-1/email": () => overrides.emailOutcome ?? { sent: true, reason: null },
    },
    patch: { "/api/v1/store/settings": () => ({ ok: true }) },
    put: {},
    download: { "/api/v1/reports/rep-1/pdf": () => ({ blob: new Blob(["%PDF-1.4"]), fileName: "moradabad-gems-weekly-2026-08-03.pdf" }) },
  };
}

describe("ReportsPage", () => {
  it("lists the vault with truthful statuses, sizes and period labels", async () => {
    renderApp(<ReportsPage />, {
      route: "/reports",
      handlers: handlers({ list: [reportRow(), reportRow({ id: "rep-2", kind: "MONTHLY", status: "BUILDING", periodLabel: "Aug 1–31, 2026", headline: null, pdfSizeBytes: null, completedAt: null })] }),
    });

    expect(await screen.findByText("Aug 3–9, 2026")).toBeInTheDocument();
    expect(screen.getByText("Aug 1–31, 2026")).toBeInTheDocument();
    expect(screen.getByText("READY")).toBeInTheDocument();
    expect(screen.getByText("BUILDING")).toBeInTheDocument();
    expect(screen.getByText("12 KB")).toBeInTheDocument();
    expect(screen.getByText("Net revenue $700.00 (+4.2% vs prior period)")).toBeInTheDocument();
  });

  it("filters the list by kind via the toolbar select", async () => {
    const { stub } = renderApp(<ReportsPage />, { route: "/reports", handlers: handlers() });
    expect(await screen.findByText("Aug 3–9, 2026")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by kind"), { target: { value: "MONTHLY" } });
    await waitFor(() =>
      expect(stub.calls.get.mock.calls.some((call: unknown[]) => call[0] === "/api/v1/reports" && (call[1] as { kind?: string }).kind === "MONTHLY")).toBe(true),
    );
  });

  it("generates a report for a chosen kind through the manage-gated dialog", async () => {
    const { stub } = renderApp(<ReportsPage />, { route: "/reports", handlers: handlers() });
    fireEvent.click(await screen.findByRole("button", { name: /generate report/i }));
    fireEvent.change(screen.getByLabelText("Report kind"), { target: { value: "MONTHLY" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/reports/generate", { kind: "MONTHLY" }));
    expect(await screen.findByText("Report ready")).toBeInTheDocument();
  });

  it("opens the drawer, renders the deterministic sections and downloads the stored PDF", async () => {
    const objectUrls: string[] = [];
    const createObjectURL = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: (u: string) => void objectUrls.push(u) });
    const clicks: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      clicks.push(this.download);
    };
    try {
      renderApp(<ReportsPage />, { route: "/reports", handlers: handlers() });
      fireEvent.click(await screen.findByRole("button", { name: "View" }));

      // Executive summary + deterministic sections.
      expect(await screen.findByText("Executive summary")).toBeInTheDocument();
      expect(screen.getByText("Revenue held steady while two stockouts capped growth.")).toBeInTheDocument();
      expect(screen.getAllByText("Net revenue").length).toBeGreaterThan(0);
      expect(screen.getAllByText("$700.00").length).toBeGreaterThan(0);
      expect(screen.getByText("+4.2% vs prior period")).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Period performance" })).toBeInTheDocument();
      expect(screen.getByRole("table", { name: "Top products" })).toBeInTheDocument();
      // Forecast strip: formatted money + method stamp.
      expect(screen.getByText(/\$1,400\.00/)).toBeInTheDocument();
      expect(screen.getByText(/method revenue\.weekly-seasonality\.v1/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));
      await waitFor(() => expect(clicks).toContain("moradabad-gems-weekly-2026-08-03.pdf"));
      expect(createObjectURL).toHaveBeenCalled();
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      vi.unstubAllGlobals();
    }
  });

  it("surfaces an honest email-unavailable outcome instead of pretending success", async () => {
    renderApp(<ReportsPage />, {
      route: "/reports",
      handlers: handlers({ emailOutcome: { sent: false, reason: "email-unavailable" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    // Wait for the detail to resolve — the footer is disabled while loading.
    expect(await screen.findByText("Executive summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /email pdf/i }));

    expect(await screen.findByText("Report was not emailed")).toBeInTheDocument();
    expect(screen.getByText(/Email delivery isn't configured/)).toBeInTheDocument();
  });

  it("saves schedule preferences as a nested reportPreferences patch", async () => {
    const { stub } = renderApp(<ReportsPage />, { route: "/reports", handlers: handlers() });
    // The preferences form hydrates from GET /api/v1/store — wait for it.
    const dailyToggle = await screen.findByLabelText("Generate Daily reports automatically");

    fireEvent.click(dailyToggle);
    fireEvent.click(screen.getByLabelText("Email reports when ready"));
    const recipient = screen.getByLabelText("Report email recipient");
    fireEvent.change(recipient, { target: { value: "owner@moradabad-gems.in" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(stub.calls.patch).toHaveBeenCalledWith("/api/v1/store/settings", {
        reportPreferences: {
          kinds: { DAILY: true, WEEKLY: true, MONTHLY: true, QUARTERLY: false },
          emailDelivery: true,
          recipientEmail: "owner@moradabad-gems.in",
        },
      }),
    );
  });

  it("hides manage controls from read-only roles but keeps the vault readable", async () => {
    renderApp(<ReportsPage />, {
      route: "/reports",
      handlers: handlers(),
      claims: { perms: ["reports:read", "store:read", "analytics:read", "notifications:read"] },
    });

    expect(await screen.findByText("Aug 3–9, 2026")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate report/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save schedule" })).not.toBeInTheDocument();
    expect(await screen.findByText(/reports:manage is required to change it/)).toBeInTheDocument();
    // Row actions still allow viewing.
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  });
});
