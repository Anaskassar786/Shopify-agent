import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { pagedResponse, renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import { storeResponse, SYNC_HISTORY, syncStatusResponse } from "../test-support/fixtures";

function settingsHandlers() {
  return {
    get: {
      "/api/v1/store": () => storeResponse(),
      "/api/v1/sync/status": () => syncStatusResponse(),
    },
    getWithMeta: { "/api/v1/sync/history": () => pagedResponse(SYNC_HISTORY) },
    patch: { "/api/v1/store/settings": () => ({ ok: true }) },
    post: {},
  };
}

describe("SettingsPage", () => {
  it("shows the store profile on the default tab", async () => {
    renderApp(<SettingsPage />, { route: "/settings", handlers: settingsHandlers() });
    expect(await screen.findByText("Moradabad Gems")).toBeInTheDocument();
    expect(screen.getByText("moradabad-gems.myshopify.com")).toBeInTheDocument();
    expect(screen.getByText("Asia/Calcutta")).toBeInTheDocument();
    expect(screen.getByText(/Completed Jul 21, 2026/)).toBeInTheDocument();
  });

  it("honors the ?tab=sync deep link and renders live module statuses", async () => {
    renderApp(<SettingsPage />, { route: "/settings?tab=sync", handlers: settingsHandlers() });
    expect(await screen.findByText("Data synchronization")).toBeInTheDocument();
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getAllByText("COMPLETED").length).toBeGreaterThan(0);
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
  });

  it("saves branding + AI preferences through the settings PATCH", async () => {
    const { stub } = renderApp(<SettingsPage />, { route: "/settings", handlers: settingsHandlers() });
    fireEvent.click(await screen.findByRole("tab", { name: "Branding & AI" }));
    const color = await screen.findByLabelText(/primary color/i);
    // Wait until the store-synced value has hydrated the form before editing.
    await waitFor(() => expect(color).toHaveValue("#6d6af8"));
    fireEvent.change(color, { target: { value: "#ff0055" } });
    fireEvent.change(screen.getByLabelText(/autonomy mode/i), { target: { value: "SEMI_AUTOMATIC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(stub.calls.patch).toHaveBeenCalledWith("/api/v1/store/settings", {
        branding: { primaryColor: "#ff0055" },
        aiPreferences: { autonomyMode: "SEMI_AUTOMATIC" },
      }),
    );
    expect(await screen.findByText("Preferences saved")).toBeInTheDocument();
  });

  it("rejects malformed hex colors client-side before any API call", async () => {
    const { stub } = renderApp(<SettingsPage />, { route: "/settings?tab=branding", handlers: settingsHandlers() });
    const color = await screen.findByLabelText(/primary color/i);
    await waitFor(() => expect(color).toHaveValue("#6d6af8"));
    fireEvent.change(color, { target: { value: "not-a-color" } });
    expect(screen.getByText(/#rgb or #rrggbb/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save preferences" })).toBeDisabled();
    expect(stub.calls.patch).not.toHaveBeenCalled();
  });

  it("hides edit affordances for role viewers", async () => {
    renderApp(<SettingsPage />, {
      route: "/settings?tab=branding",
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
      handlers: settingsHandlers(),
    });
    await screen.findByLabelText(/primary color/i);
    expect(screen.queryByRole("button", { name: "Save preferences" })).not.toBeInTheDocument();
    expect(screen.getByText(/can view these settings/)).toBeInTheDocument();
  });
});
