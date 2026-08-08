import type { ReactNode } from "react";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@profit/ui";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../pages/DashboardPage";
import { BillingPage } from "../pages/BillingPage";
import { SupportPage } from "../pages/SupportPage";
import { ExportsPage } from "../pages/ExportsPage";
import { CopilotPage } from "../pages/CopilotPage";
import { ReportsPage } from "../pages/ReportsPage";
import { AdminApp } from "../admin/AdminApp";
import { pagedResponse, renderApp, type StubHandlers } from "../test-support/render";
import {
  ADMIN_MERCHANTS,
  adminOverviewFixture,
  AUDIT_ROWS,
  BILLING_HISTORY,
  INVENTORY_LEVELS,
  billingOverviewFixture,
  plansCatalogFixture,
  roiReportFixture,
  storeResponse,
  summaryResponse,
  syncStatusResponse,
  TOP_CUSTOMERS,
  TOP_PRODUCTS,
} from "../test-support/fixtures";

/**
 * WCAG 2.2 AA gate (ADR 29): axe-core runs against the REAL mounted component
 * tree — providers, route shell and all — not snapshots. Two rules are scoped
 * out with reason, not deleted from the audit trail:
 *   - color-contrast: jsdom performs no paint/layout, so computed-color checks
 *     read unthemed defaults and lie in both directions. Contrast is a token
 *     design invariant (styles.css), asserted at the shell review instead.
 *   - region: page components mounted in isolation are fragments of the app
 *     shell which provides the landmarks; full-document landmark rules belong
 *     to the shell layer, not the component bench.
 * Everything else — labels, names, roles, keyboard/focus semantics, ARIA —
 * must report ZERO violations.
 */

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
};

async function expectNoViolations(container: Element, surface: string): Promise<void> {
  const results = await axe.run(container, AXE_OPTIONS);
  const report = results.violations
    .map(
      (violation) =>
        `${violation.id}: ${violation.description} [${violation.impact ?? "unknown"}]\n` +
        violation.nodes.map((node) => `  ${node.target.join(" ")}`).join("\n"),
    )
    .join("\n");
  expect(results.violations, `${surface} has axe violations:\n${report}`).toHaveLength(0);
}

// ── Merchant surfaces (renderApp: production-identical provider tree) ────────

function dashboardHandlers(): StubHandlers {
  return {
    get: {
      "/api/v1/store": () => storeResponse(),
      "/api/v1/sync/status": () => syncStatusResponse(),
      "/api/v1/analytics/summary": () => summaryResponse(),
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

function billingHandlers(): StubHandlers {
  return {
    get: {
      "/api/v1/billing/overview": () => billingOverviewFixture(),
      "/api/v1/billing/plans": () => plansCatalogFixture(),
      "/api/v1/billing/history": () => BILLING_HISTORY,
      "/api/v1/analytics/roi": () => roiReportFixture(),
      "/api/v1/store": () => storeResponse(),
    },
  };
}

describe("axe WCAG 2.2 AA — merchant embedded surfaces", () => {
  it("Dashboard has no violations", async () => {
    const view = renderApp(<DashboardPage />, { handlers: dashboardHandlers() });
    await screen.findByText("Net revenue");
    await expectNoViolations(document.body, "DashboardPage");
    view.unmount();
  });

  it("Billing has no violations", async () => {
    const view = renderApp(<BillingPage />, { route: "/billing", handlers: billingHandlers() });
    await screen.findByText(/Growth plan/);
    await expectNoViolations(document.body, "BillingPage");
    view.unmount();
  });

  it("Support (with the M7 legal card) has no violations", async () => {
    const view = renderApp(<SupportPage />, {
      route: "/support",
      handlers: {
        get: {
          "/api/v1/store": () => storeResponse(),
          "/api/v1/support/tickets": () => ({ rows: [] }),
        },
      },
    });
    await screen.findByText("Legal & policies");
    await expectNoViolations(document.body, "SupportPage");
    view.unmount();
  });

  it("Exports (table + actions) has no violations", async () => {
    const view = renderApp(<ExportsPage />, {
      route: "/exports",
      handlers: {
        get: { "/api/v1/exports": () => ({ rows: [], total: 0 }) },
      },
    });
    await screen.findByText("No exports yet");
    await expectNoViolations(document.body, "ExportsPage");
    view.unmount();
  });

  it("Copilot (M8 chat surface) has no violations", async () => {
    const view = renderApp(<CopilotPage />, {
      route: "/copilot",
      handlers: {
        get: { "/api/v1/copilot/conversations": () => [] },
      },
    });
    await screen.findByText("Ask about your store");
    await expectNoViolations(document.body, "CopilotPage");
    view.unmount();
  });

  it("Reports vault (M8 schedule + table) has no violations", async () => {
    const view = renderApp(<ReportsPage />, {
      route: "/reports",
      handlers: {
        get: {
          "/api/v1/store": () => storeResponse(),
          "/api/v1/reports": () => [],
        },
      },
    });
    await screen.findByText("No reports yet");
    await expectNoViolations(document.body, "ReportsPage");
    view.unmount();
  });
});

// ── Operator console (AdminApp: key gate → access-review read model) ─────────

const A11Y_REVIEW = {
  store: {
    storeId: ADMIN_MERCHANTS[0]!.storeId,
    name: ADMIN_MERCHANTS[0]!.shopDomain,
    shopDomain: ADMIN_MERCHANTS[0]!.shopDomain,
    status: "ACTIVE",
    installedAt: "2026-07-20T10:00:00.000Z",
    uninstalledAt: null,
  },
  members: [
    {
      userId: "u-a11y",
      email: "owner@brasscity.example",
      fullName: "Rhea Brass",
      status: "ACTIVE",
      roleCode: "OWNER",
      permissionCount: 24,
      memberSince: "2026-07-20T10:00:00.000Z",
      lastLoginAt: "2026-08-07T09:00:00.000Z",
    },
  ],
  activeOverrides: [],
  recentActions: [],
};

function adminFetchStub(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const respond = (status: number, data: unknown): Response =>
      new Response(JSON.stringify({ success: true, data }), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "/api/v1/admin/session") {
      return respond(201, {
        token: "v1.a11y-session",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        operatorId: "a11y@profit",
      });
    }
    if (headers["X-Platform-Admin-Key"] !== "a11y-key") {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: "AUTHENTICATION_FAILED", message: "key rejected" }],
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith("/api/v1/admin/overview")) return respond(200, adminOverviewFixture());
    if (url.startsWith("/api/v1/admin/merchants")) return respond(200, ADMIN_MERCHANTS);
    if (url.startsWith("/api/v1/admin/access-review/sessions")) return respond(200, []);
    if (url.startsWith("/api/v1/admin/access-review")) return respond(200, A11Y_REVIEW);
    throw new Error(`unstubbed admin fetch: ${url}`);
  });
}

describe("axe WCAG 2.2 AA — operator console (access review)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it("Access review console has no violations after the step-up gate", async () => {
    vi.stubGlobal("fetch", adminFetchStub());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    const tree: ReactNode = (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <MemoryRouter initialEntries={["/admin"]}>
              <AdminApp />
            </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
    rtlRender(tree);

    fireEvent.change(screen.getByLabelText(/platform admin key/i), { target: { value: "a11y-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock console/i }));
    await screen.findByText("Platform overview");
    fireEvent.click(screen.getByRole("link", { name: /access review/i }));
    await screen.findByText("Pick the store");
    await screen.findByText("Write-authority grants");

    await expectNoViolations(document.body, "AdminApp /admin/access-review");
  });
});
