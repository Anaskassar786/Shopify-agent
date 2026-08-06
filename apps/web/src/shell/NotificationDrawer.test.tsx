import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationDrawer } from "./NotificationDrawer";
import { renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import { NOTIFICATIONS, storeResponse } from "../test-support/fixtures";
import { pagedResponse } from "../test-support/render";
import { Route, Routes } from "react-router-dom";

function drawerHandlers(unread = 1) {
  return {
    getWithMeta: {
      "/api/v1/notifications": () => pagedResponse(NOTIFICATIONS, 2, { unread }),
    },
    post: {
      "/api/v1/notifications/read-all": () => ({ markedRead: unread }),
    },
    get: {
      "/api/v1/store": () => storeResponse(),
    },
  };
}

function renderDrawer(onClose = vi.fn(), unread = 1) {
  return renderApp(
    <>
      <NotificationDrawer open onClose={onClose} />
      <Routes>
        <Route path="/dashboard" element={<p>dashboard content</p>} />
      </Routes>
    </>,
    { route: "/dashboard", handlers: drawerHandlers(unread) },
  );
}

describe("NotificationDrawer", () => {
  it("lists notifications with unread markers and category badges", async () => {
    renderDrawer();
    expect(await screen.findByText("Data sync complete")).toBeInTheDocument();
    expect(screen.getByText("New sign-in")).toBeInTheDocument();
    expect(screen.getByText("SYSTEM")).toBeInTheDocument();
    expect(screen.getByText("SECURITY")).toBeInTheDocument();
    expect(screen.getByLabelText("Unread")).toBeInTheDocument();
    expect(screen.getByLabelText("Read")).toBeInTheDocument();
  });

  it("marks an unread row read and follows its actionUrl", async () => {
    const onClose = vi.fn();
    const { stub } = renderDrawer(onClose);
    const row = await screen.findByText("Data sync complete");
    fireEvent.click(row);
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/notifications/n-1/read", {}),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("disables mark-all when nothing is unread", async () => {
    renderDrawer(vi.fn(), 0);
    await screen.findByText("Data sync complete");
    expect(screen.getByRole("button", { name: /mark all as read/i })).toBeDisabled();
  });

  it("hides mark-all entirely without notifications:update", async () => {
    renderApp(
      <NotificationDrawer open onClose={vi.fn()} />,
      {
        route: "/dashboard",
        claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
        user: { ...TEST_USER, role: "VIEWER" },
        handlers: drawerHandlers(1),
      },
    );
    await screen.findByText("Data sync complete");
    expect(screen.queryByRole("button", { name: /mark all as read/i })).not.toBeInTheDocument();
  });
});
