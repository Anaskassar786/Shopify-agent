import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { pagedResponse, renderApp, TEST_USER, VIEWER_PERMISSIONS } from "./test-support/render";
import {
  AUDIT_ROWS,
  INVENTORY_LEVELS,
  NOTIFICATIONS,
  storeResponse,
  summaryResponse,
  syncStatusResponse,
  TOP_CUSTOMERS,
  TOP_PRODUCTS,
} from "./test-support/fixtures";

/** Boot-level smoke: the real route table, lazily resolved, inside the real auth flow. */

function appHandlers() {
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
      "/api/v1/notifications": () => pagedResponse(NOTIFICATIONS, 2, { unread: 1 }),
    },
  };
}

describe("App routes", () => {
  it("redirects / to the dashboard and lazy-loads it inside the shell", async () => {
    renderApp(<App />, { route: "/", handlers: appHandlers() });
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText("Net revenue")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Products/ })).toBeInTheDocument();
  });

  it("serves the support section without permission requirements", async () => {
    renderApp(<App />, { route: "/support", handlers: appHandlers() });
    expect(await screen.findByRole("heading", { name: "Support" })).toBeInTheDocument();
  });

  it("guards restricted sections for roles without the permission", async () => {
    renderApp(<App />, {
      route: "/audit-logs",
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
      handlers: appHandlers(),
    });
    expect(await screen.findByText("No access to this section")).toBeInTheDocument();
    expect(screen.getByText(/audit:read/)).toBeInTheDocument();
  });

  it("falls into NotFound for unknown paths", async () => {
    renderApp(<App />, { route: "/definitely-nowhere", handlers: appHandlers() });
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});
