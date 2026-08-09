import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalyticsPage } from "./AnalyticsPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import { summaryResponse, TOP_CUSTOMERS, TOP_PRODUCTS } from "../test-support/fixtures";

/**
 * Analytics page (M2 surface, backfilled M6): every widget reads the same
 * live metrics pipelines as the dashboard — nothing is computed client-side,
 * ranges round-trip through the API, and empty ledgers stay honest.
 */

function handlers(overrides: Partial<StubHandlers["get"]> = {}): StubHandlers {
  return {
    get: {
      "/api/v1/analytics/summary": () => summaryResponse(),
      "/api/v1/analytics/top-products": () => TOP_PRODUCTS,
      "/api/v1/analytics/top-customers": () => TOP_CUSTOMERS,
      ...overrides,
    },
    getWithMeta: {},
    post: {},
    patch: {},
    put: {},
  };
}

describe("AnalyticsPage", () => {
  it("renders the stat cards, both leaderboards and the trend charts from live payloads", async () => {
    renderApp(<AnalyticsPage />, { handlers: handlers() });

    // Stat cards compute straight from the totals block.
    expect(await screen.findByText("Gross sales")).toBeInTheDocument();
    expect((await screen.findAllByText("$1,299.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("Avg. order value")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Returning")).toBeInTheDocument();

    // Charts mount with the series the pipeline produced.
    expect(screen.getByTestId("analytics-trend")).toBeInTheDocument();

    // Leaderboards list the real rows (default range is 30 days).
    expect(screen.getByText(/By revenue · last 30 days/)).toBeInTheDocument();
    const firstProduct = TOP_PRODUCTS[0];
    const firstCustomer = TOP_CUSTOMERS[0];
    expect(firstProduct).toBeDefined();
    expect(firstCustomer).toBeDefined();
    expect(screen.getByText(firstProduct!.title)).toBeInTheDocument();
    const customerName = [firstCustomer!.firstName, firstCustomer!.lastName].filter(Boolean).join(" ");
    const link = screen.getByRole("link", { name: new RegExp(customerName.length > 0 ? customerName : "Guest") });
    expect(link).toHaveAttribute("href", `/customers/${firstCustomer!.customerId}`);
  });

  it("round-trips range changes through the API for all three queries", async () => {
    const { stub } = renderApp(<AnalyticsPage />, { handlers: handlers() });
    await screen.findByText("Gross sales");

    fireEvent.click(screen.getByRole("tab", { name: "90 days" }));
    await waitFor(() => {
      expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/analytics/summary", { days: 90 });
      expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/analytics/top-products", { days: 90 });
      expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/analytics/top-customers", { days: 90 });
    });
    expect(await screen.findByText(/Daily · last 90 days/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/analytics/summary", { days: 7 }));
    expect(await screen.findByText(/By revenue · last 7 days/)).toBeInTheDocument();
  });

  it("keeps empty leaderboards honest instead of inventing rows", async () => {
    renderApp(<AnalyticsPage />, {
      handlers: handlers({
        "/api/v1/analytics/top-products": () => [],
        "/api/v1/analytics/top-customers": () => [],
      }),
    });

    expect(await screen.findByText("No product sales in range")).toBeInTheDocument();
    expect(screen.getByText("No customer data yet")).toBeInTheDocument();
  });
});
