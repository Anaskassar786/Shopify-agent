import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardPage } from "./DashboardPage";
import { pagedResponse, renderApp } from "../test-support/render";
import {
  INVENTORY_LEVELS,
  AUDIT_ROWS,
  storeResponse,
  summaryResponse,
  syncStatusResponse,
  TOP_CUSTOMERS,
  TOP_PRODUCTS,
} from "../test-support/fixtures";

function dashboardHandlers(summary = summaryResponse()) {
  return {
    get: {
      "/api/v1/store": () => storeResponse(),
      "/api/v1/sync/status": () => syncStatusResponse(),
      "/api/v1/analytics/summary": () => summary,
      "/api/v1/analytics/top-products": () => TOP_PRODUCTS,
      "/api/v1/analytics/top-customers": () => TOP_CUSTOMERS,
    },
    getWithMeta: {
      "/api/v1/inventory/levels": () => pagedResponse(INVENTORY_LEVELS),
      "/api/v1/audit-logs": () => pagedResponse(AUDIT_ROWS),
      "/api/v1/notifications": () => pagedResponse([], 0, { unread: 0 }),
    },
  };
}

describe("DashboardPage", () => {
  it("renders hero stats computed from the real summary payload", async () => {
    renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    await screen.findByText("Net revenue");
    expect(screen.getByText("$1,299.00")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument(); // orders
    expect(screen.getByText("45")).toBeInTheDocument(); // new customers
    expect(screen.getByText("$10.82")).toBeInTheDocument(); // AOV
    expect(screen.getByTestId("revenue-trend")).toBeInTheDocument();
  });

  it("switches ranges against the API", async () => {
    const { stub } = renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    await screen.findByText("Net revenue");
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() =>
      expect(stub.calls.get).toHaveBeenCalledWith("/api/v1/analytics/summary", { days: 7 }),
    );
  });

  it("shows the honest zero state instead of inventing numbers", async () => {
    const empty = summaryResponse();
    const zeroed = {
      ...empty,
      totals: { ...empty.totals, ordersCount: 0, grossSalesCents: 0 },
    };
    renderApp(<DashboardPage />, { handlers: dashboardHandlers(zeroed) });
    expect(await screen.findByText("No sales data in this range yet")).toBeInTheDocument();
    expect(screen.queryByTestId("revenue-trend")).not.toBeInTheDocument();
  });

  it("rolls up store health from sync module states", async () => {
    renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    expect(await screen.findByText("Synced · 7")).toBeInTheDocument();
    expect(screen.getByText(/Last successful sync/)).toBeInTheDocument();
  });

  it("lists top products and customers from the metrics pipeline", async () => {
    renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    expect(await screen.findByText("Alpha Runner")).toBeInTheDocument();
    expect(screen.getByText("Sam Iyer")).toBeInTheDocument();
    expect(screen.getByText("$820.00")).toBeInTheDocument();
  });

  it("renders recent activity from the audit trail", async () => {
    renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    expect(await screen.findByText("store.settings.updated")).toBeInTheDocument();
  });
});
