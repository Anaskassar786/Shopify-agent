import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationsPage } from "./NotificationsPage";
import { AuditLogsPage } from "./AuditLogsPage";
import { SupportPage } from "./SupportPage";
import { pagedResponse, renderApp } from "../test-support/render";
import { AUDIT_ROWS, NOTIFICATIONS } from "../test-support/fixtures";

describe("NotificationsPage", () => {
  const handlers = (unread = 1) => ({
    getWithMeta: {
      "/api/v1/notifications": () => pagedResponse(NOTIFICATIONS, 2, { unread }),
    },
    post: { "/api/v1/notifications/read-all": () => ({ markedRead: unread }) },
  });

  it("lists notifications with tabs reflecting the unread count", async () => {
    renderApp(<NotificationsPage />, { route: "/notifications", handlers: handlers(1) });
    expect(await screen.findByText("Data sync complete")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Unread 1/ })).toBeInTheDocument();
  });

  it("switches to the unread-only view via the API filter", async () => {
    const { stub } = renderApp(<NotificationsPage />, { route: "/notifications", handlers: handlers(1) });
    await screen.findByText("Data sync complete");
    fireEvent.click(screen.getByRole("tab", { name: /Unread/ }));
    await waitFor(() =>
      expect(stub.calls.getWithMeta).toHaveBeenCalledWith(
        "/api/v1/notifications",
        expect.objectContaining({ unreadOnly: "true" }),
      ),
    );
  });

  it("marks all read via the API and celebrates", async () => {
    const { stub } = renderApp(<NotificationsPage />, { route: "/notifications", handlers: handlers(2) });
    await screen.findByText("Data sync complete");
    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/notifications/read-all", {}));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });
});

describe("AuditLogsPage", () => {
  const handlers = {
    getWithMeta: { "/api/v1/audit-logs": () => pagedResponse(AUDIT_ROWS) },
  };

  it("renders the trail with results and actors", async () => {
    renderApp(<AuditLogsPage />, { route: "/audit-logs", handlers });
    expect(await screen.findByText("store.settings.updated")).toBeInTheDocument();
    expect(screen.getAllByText("SUCCESS").length).toBe(2);
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument(); // null actor
  });

  it("prefix-filters actions server-side", async () => {
    const { stub } = renderApp(<AuditLogsPage />, { route: "/audit-logs", handlers });
    await screen.findByText("store.settings.updated");
    fireEvent.change(screen.getByLabelText("Filter by action prefix"), { target: { value: "billing" } });
    await waitFor(() =>
      expect(stub.calls.getWithMeta).toHaveBeenCalledWith(
        "/api/v1/audit-logs",
        expect.objectContaining({ action: "billing" }),
      ),
    );
  });
});

/* BillingPage moved to billing-page.test.tsx (M5: the page now runs on the
   /billing/overview + plans + history + roi wires, covered there). */

describe("SupportPage", () => {
  it("renders the real contact channel and truthful FAQs", async () => {
    renderApp(<SupportPage />, { route: "/support" });
    expect(screen.getByText("support@profittool.ai")).toBeInTheDocument();
    expect(screen.queryByText(/chat/i)).not.toBeInTheDocument(); // no fake chat widget
    const question = screen.getByRole("button", { name: /how long is the free trial/i });
    expect(question).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(question);
    expect(question).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/shown on the Billing page/)).toBeInTheDocument();
  });
});
