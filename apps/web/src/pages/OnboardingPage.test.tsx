import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { advanceBlockedReason, ONBOARDING_STEPS, OnboardingPage } from "./OnboardingPage";
import { pagedResponse, renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import { storeResponse, subscriptionResponse, SYNC_HISTORY, syncStatusResponse } from "../test-support/fixtures";

describe("advanceBlockedReason (pure)", () => {
  const base = {
    step: 0,
    anySyncRunning: false,
    allModulesSynced: false,
    canEditSettings: true,
    canManageBilling: true,
    hasSubscription: true,
  };

  it("blocks step 1 only while a sync is actively running", () => {
    expect(advanceBlockedReason({ ...base, step: 1, anySyncRunning: true })).toMatch(/sync is running/);
    expect(advanceBlockedReason({ ...base, step: 1, anySyncRunning: false })).toBeNull();
  });

  it("blocks activation without subscription when the user cannot manage billing", () => {
    expect(
      advanceBlockedReason({ ...base, step: 3, hasSubscription: false, canManageBilling: false }),
    ).toMatch(/billing permission/);
    expect(
      advanceBlockedReason({ ...base, step: 3, hasSubscription: false, canManageBilling: true }),
    ).toBeNull();
  });

  it("never blocks navigation elsewhere", () => {
    for (let step = 0; step < ONBOARDING_STEPS.length; step += 1) {
      if (step === 1 || step === 3) continue;
      expect(advanceBlockedReason({ ...base, step })).toBeNull();
    }
  });
});

describe("OnboardingPage wizard", () => {
  const handlers = {
    get: {
      "/api/v1/store": () => storeResponse({ onboardingCompletedAt: null }),
      "/api/v1/sync/status": () => syncStatusResponse(),
      "/api/v1/subscription": () => subscriptionResponse(),
    },
    getWithMeta: { "/api/v1/sync/history": () => pagedResponse(SYNC_HISTORY) },
    patch: { "/api/v1/store/settings": () => ({ ok: true }) },
    post: { "/api/v1/store/onboarding/complete": () => ({ ok: true }) },
  };

  function renderWizard(options: Parameters<typeof renderApp>[1] = {}) {
    return renderApp(
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/dashboard" element={<p>dashboard content</p>} />
      </Routes>,
      { route: "/onboarding", handlers, ...options },
    );
  }

  it("walks all four steps against the real backend state and finishes", async () => {
    const { stub } = renderWizard();

    // Step 0 — connected store summary from /store.
    expect(await screen.findByText("Your store is connected")).toBeInTheDocument();
    expect(screen.getByText("moradabad-gems.myshopify.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Step 1 — live sync status (all completed in fixture) with confirmation line.
    expect(await screen.findByText("Pull in your data")).toBeInTheDocument();
    expect(await screen.findByText(/Every module has completed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Step 2 — preferences persist via PATCH before moving on.
    expect(await screen.findByText("Make it yours")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(stub.calls.patch).toHaveBeenCalledWith("/api/v1/store/settings", {
        aiPreferences: { autonomyMode: "MANUAL" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Step 3 — trial already provisioned at install; finish writes onboardingComplete.
    expect(await screen.findByText("Your trial is running")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /enter your dashboard/i }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/store/onboarding/complete", {}),
    );
    expect(await screen.findByText("dashboard content")).toBeInTheDocument();
  });

  it("disables finishing for roles without settings:update", async () => {
    renderWizard({
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
    });
    await screen.findByText("Your store is connected");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText("Pull in your data");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText("Make it yours");
    expect(screen.queryByRole("button", { name: "Save preferences" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByText("Your trial is running");
    expect(screen.getByRole("button", { name: /enter your dashboard/i })).toBeDisabled();
    expect(screen.getByText(/writes a store setting/)).toBeInTheDocument();
  });
});
