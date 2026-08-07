import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { AppLayout } from "./AppLayout";
import { pagedResponse, renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import { NOTIFICATIONS, storeResponse, syncStatusResponse } from "../test-support/fixtures";

function layoutHandlers(overrides: { readonly onboardingCompletedAt?: string | null; readonly unread?: number } = {}) {
  const unread = overrides.unread ?? 3;
  return {
    get: {
      "/api/v1/store": () =>
        storeResponse({
          ...( "onboardingCompletedAt" in overrides
            ? { onboardingCompletedAt: overrides.onboardingCompletedAt ?? null }
            : {}),
        }),
      "/api/v1/sync/status": () => syncStatusResponse(),
    },
    getWithMeta: {
      "/api/v1/notifications": () => pagedResponse(NOTIFICATIONS, 2, { unread }),
    },
  };
}

function renderLayout(options: Parameters<typeof renderApp>[1] = {}) {
  return renderApp(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<p>dashboard content</p>} />
      </Route>
      <Route path="/onboarding" element={<p>onboarding wizard</p>} />
    </Routes>,
    { route: "/dashboard", ...options },
  );
}

describe("AppLayout", () => {
  it("renders the grouped sidebar with every permitted section for an owner", async () => {
    renderLayout({ handlers: layoutHandlers() });
    await screen.findByText("dashboard content");
    for (const label of [
      "Dashboard", "AI Command Center", "Recommendations", "Customers", "Products", "Orders",
      "Inventory", "Automation", "Analytics", "Campaigns", "Notifications", "Audit Logs",
      "Exports", "Billing", "Settings", "Support",
    ]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    for (const group of ["Overview", "Intelligence", "Catalog", "System"]) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0);
    }
    // M6 promoted the last roadmap surface — every section is live now, so
    // no milestone chips render anywhere in the sidebar.
    expect(screen.queryByText("M4")).not.toBeInTheDocument();
    expect(screen.queryByText("M5")).not.toBeInTheDocument();
    expect(screen.queryByText("M6")).not.toBeInTheDocument();
  });

  it("filters the sidebar to the viewer permission set", async () => {
    renderLayout({
      handlers: layoutHandlers(),
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
    });
    await screen.findByText("dashboard content");
    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Products/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Audit Logs/ })).not.toBeInTheDocument();
    // Viewers hold notifications:read (server-seeded) — the bell stays, the
    // drawer merely drops mark-all (covered in NotificationDrawer tests).
    expect(screen.getByRole("button", { name: /notifications/i })).toBeInTheDocument();
  });

  it("shows the unread count on the bell from the live API", async () => {
    renderLayout({ handlers: layoutHandlers({ unread: 3 }) });
    const bell = await screen.findByRole("button", { name: /notifications, 3 unread/i });
    expect(bell).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("redirects into the onboarding wizard until onboardingCompletedAt is set", async () => {
    renderLayout({ handlers: layoutHandlers({ onboardingCompletedAt: null }) });
    expect(await screen.findByText("onboarding wizard")).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("opens the command palette via the ⌘K hotkey and closes via Escape", async () => {
    renderLayout({ handlers: layoutHandlers() });
    await screen.findByText("dashboard content");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByLabelText("Command palette search");
    expect(input).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Command palette search")).not.toBeInTheDocument());
  });

  it("surfaces the offline chip when the browser reports no connection", async () => {
    const spy = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    renderLayout({ handlers: layoutHandlers() });
    await screen.findByText("dashboard content");
    expect(screen.getByText("Offline")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("reports sync freshness in the sidebar footer", async () => {
    renderLayout({ handlers: layoutHandlers() });
    await screen.findByText("dashboard content");
    expect(screen.getByText("Data fresh — all modules synced")).toBeInTheDocument();
  });
});
