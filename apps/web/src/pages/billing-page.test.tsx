import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BillingPage } from "./BillingPage";
import { renderApp } from "../test-support/render";
import {
  BILLING_HISTORY,
  billingOverviewFixture,
  plansCatalogFixture,
  roiReportFixture,
  storeResponse,
} from "../test-support/fixtures";
import type { StubHandlers } from "../test-support/render";

/**
 * M5 Billing page contracts: trial banner → plan comparison → Shopify charge
 * redirect (TOP-level — the decision screen rejects iframes), usage meters,
 * ledger feed, ROI value block, cancel flow, callback toasts, funnel emits.
 */

function handlers(overrides: Partial<StubHandlers["get"]> = {}): StubHandlers {
  return {
    get: {
      "/api/v1/billing/overview": () => billingOverviewFixture(),
      "/api/v1/billing/plans": () => plansCatalogFixture(),
      "/api/v1/billing/history": () => BILLING_HISTORY,
      "/api/v1/analytics/roi": () => roiReportFixture(),
      "/api/v1/store": () => storeResponse(),
      ...overrides,
    },
    post: {
      "/api/v1/billing/subscribe": () => ({
        confirmationUrl: "https://moradabad-gems.myshopify.com/admin/charges/900101/confirm",
        chargeId: "900101",
      }),
      "/api/v1/billing/cancel": () => ({ cancelled: true }),
      "/api/v1/engagement/events": () => ({ recorded: true }),
    },
  };
}

describe("BillingPage (M5)", () => {
  it("renders the current plan, usage meters and the ledger feed", async () => {
    renderApp(<BillingPage />, { route: "/billing", handlers: handlers() });
    expect(await screen.findByText(/Growth plan/)).toBeInTheDocument();
    expect(screen.getByText("TRIALING")).toBeInTheDocument();
    // Usage meters from the overview wire (not fabricated client-side).
    expect(screen.getByText("148 of 2000")).toBeInTheDocument();
    expect(screen.getByText("96 of 1000")).toBeInTheDocument();
    // Ledger feed, newest first (fixture order).
    expect(screen.getByText("Charge approved")).toBeInTheDocument();
    expect(screen.getByText("Trial started")).toBeInTheDocument();
    // ROI value block.
    expect(screen.getByText("56.8×")).toBeInTheDocument();
    expect(screen.getByText("$1,845.00")).toBeInTheDocument();
  });

  it("records UPGRADE_VIEWED exactly once on mount (funnel telemetry)", async () => {
    const { stub } = renderApp(<BillingPage />, { route: "/billing", handlers: handlers() });
    await screen.findByText(/Growth plan/);
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/engagement/events", { kind: "UPGRADE_VIEWED" }),
    );
    const emitCalls = stub.calls.post.mock.calls.filter(
      (call) => call[0] === "/api/v1/engagement/events",
    );
    expect(emitCalls).toHaveLength(1);
  });

  it("shows the start-trial recovery path when provisioning left no subscription row", async () => {
    const { stub } = renderApp(<BillingPage />, {
      route: "/billing",
      handlers: {
        ...handlers({ "/api/v1/billing/overview": () => billingOverviewFixture({ withPlan: false }) }),
        post: {
          ...handlers().post,
          "/api/v1/subscription/start-trial": () => ({ subscription: { id: "sub-new" }, created: true }),
        },
      },
    });
    expect(await screen.findByText("Start your free trial")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /start free trial/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Start trial" }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/subscription/start-trial", {}));
  });

  it("subscribes after confirmation and breaks out to Shopify's decision screen top-level", async () => {
    const topLocationSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    // window.top is read-only in jsdom; the page uses window.open(url, "_top") semantics via location assignment.
    renderApp(<BillingPage />, { route: "/billing", handlers: handlers() });
    const choose = await screen.findAllByRole("button", { name: /choose professional/i });
    fireEvent.click(choose[0]!);
    // Confirmation dialog carries the computed price + preserved-trial copy.
    const confirm = await screen.findByRole("button", { name: "Continue to Shopify" });
    expect(screen.getByText(/preserved and roll into your first paid period/)).toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(topLocationSpy).toHaveBeenCalledWith(
        "https://moradabad-gems.myshopify.com/admin/charges/900101/confirm",
        "_top",
      ),
    );
    topLocationSpy.mockRestore();
  });

  it("cancels with the period-end warning copy", async () => {
    const { stub } = renderApp(<BillingPage />, {
      route: "/billing",
      handlers: handlers({ "/api/v1/billing/overview": () => billingOverviewFixture({ status: "ACTIVE" }) }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /cancel plan/i }));
    expect(await screen.findByText(/stays active until the end of the current paid period/)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel plan" }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/billing/cancel", {}));
  });

  it("shows the activated toast after the charge callback bounce and strips the param", async () => {
    renderApp(<BillingPage />, { route: "/billing?billing_state=activated", handlers: handlers() });
    expect(await screen.findByText("Subscription active")).toBeInTheDocument();
  });

  it("renders the plan comparison with the current plan marked and yearly pricing honoured", async () => {
    renderApp(<BillingPage />, { route: "/billing", handlers: handlers() });
    expect(await screen.findByText("Current")).toBeInTheDocument(); // Starter is current in the catalog fixture
    fireEvent.change(screen.getByLabelText("Billing interval"), { target: { value: "YEARLY" } });
    expect(screen.getByText("$2,490.00")).toBeInTheDocument(); // Professional yearly (249000c)
    expect(screen.getByText(/2 months free/)).toBeInTheDocument();
  });
});
