import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { RecommendationsPage } from "./RecommendationsPage";
import { RecommendationDetailPage } from "./RecommendationDetailPage";
import { AiCommandCenterPage } from "./AiCommandCenterPage";
import { AutomationPage } from "./AutomationPage";
import { pagedResponse, renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import {
  aiOverviewResponse,
  aiOverviewZeroState,
  automationOverviewResponse,
  recommendationDetail,
  RECOMMENDATION_ID,
  RECOMMENDATIONS,
  storeResponse,
  syncStatusResponse,
} from "../test-support/fixtures";
import type { RecommendationRow } from "../lib/api-types";
import { ApiError } from "../lib/api-client";

/**
 * M4 AI surfaces: approve/reject flows, explainability rendering, command
 * center zero state vs live state, automation policy editing. All reads go
 * through the stubbed ApiClient — no network, real component tree.
 */

const APPROVE_PATH = `/api/v1/recommendations/${RECOMMENDATION_ID}/approve`;
const REJECT_PATH = `/api/v1/recommendations/${RECOMMENDATION_ID}/reject`;
const DETAIL_PATH = `/api/v1/recommendations/${RECOMMENDATION_ID}`;

function recommendationHandlers(items: readonly RecommendationRow[] = RECOMMENDATIONS) {
  return {
    get: {},
    getWithMeta: {
      "/api/v1/recommendations": () => pagedResponse(items),
    },
    post: {
      "/api/v1/recommendations/run": () => ({ jobId: "ai:manual:x:1" }),
      [APPROVE_PATH]: () => ({ ...RECOMMENDATIONS[0], status: "APPROVED" }),
      [REJECT_PATH]: () => ({ ...RECOMMENDATIONS[0], status: "REJECTED" }),
    },
  };
}

describe("RecommendationsPage", () => {
  it("renders the queue with priorities, confidence and estimates", async () => {
    renderApp(<RecommendationsPage />, { route: "/recommendations", handlers: recommendationHandlers() });
    expect(await screen.findByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
    expect(await screen.findByText("Recover Mia's abandoned cart")).toBeInTheDocument();
    expect(screen.getByText("Restock Alpha Runner before the weekend")).toBeInTheDocument();
    // Priority + risk + confidence + money all render from the wire row.
    expect(screen.getAllByText("High").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("85")).toBeInTheDocument();
    expect(screen.getAllByText(/\+\$11\.52/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$9\.60 cost/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/ROI 1\.2×/).length).toBeGreaterThanOrEqual(1);
  });

  it("switches the status filter via the tabs and re-queries the API", async () => {
    const { stub } = renderApp(<RecommendationsPage />, {
      route: "/recommendations",
      handlers: recommendationHandlers(),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Executed" }));
    await waitFor(() => {
      const called = stub.calls.getWithMeta.mock.calls.some(
        (call) =>
          call[0] === "/api/v1/recommendations" &&
          (call[1] as { readonly status?: string } | undefined)?.status === "EXECUTED",
      );
      expect(called).toBe(true);
    });
  });

  it("approve asks for confirmation, then posts and celebrates", async () => {
    const { stub } = renderApp(<RecommendationsPage />, {
      route: "/recommendations",
      handlers: recommendationHandlers(),
    });
    fireEvent.click(await screen.findByRole("button", { name: /approve recover mia's abandoned cart/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Approve this recommendation?");
    fireEvent.click(screen.getByRole("button", { name: "Approve & queue" }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/recommendations\/.+\/approve$/),
        {},
      ),
    );
    expect(await screen.findByText("Execution queued")).toBeInTheDocument();
  });

  it("reject collects an optional reason and posts it to the learning loop", async () => {
    const { stub } = renderApp(<RecommendationsPage />, {
      route: "/recommendations",
      handlers: recommendationHandlers(),
    });
    fireEvent.click(await screen.findByRole("button", { name: /reject recover mia's abandoned cart/i }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Reject this recommendation?");
    fireEvent.change(screen.getByLabelText(/reason \(optional\)/i), {
      target: { value: "Discounting hurts my margin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject recommendation" }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/recommendations\/.+\/reject$/),
        { reason: "Discounting hurts my margin" },
      ),
    );
    expect(await screen.findByText("Recommendation rejected")).toBeInTheDocument();
  });

  it("zero state offers a manual run for approvers but not viewers", async () => {
    renderApp(<RecommendationsPage />, { route: "/recommendations", handlers: recommendationHandlers([]) });
    expect(await screen.findByText("Nothing waiting for a decision")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Run analysis now" }).length).toBeGreaterThanOrEqual(1);
  });

  it("hides decide affordances for viewers (RBAC mirrored client-side)", async () => {
    renderApp(<RecommendationsPage />, {
      route: "/recommendations",
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
      handlers: recommendationHandlers(),
    });
    await screen.findByText("Recover Mia's abandoned cart");
    expect(screen.queryByRole("button", { name: /approve /i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject /i })).not.toBeInTheDocument();
  });
});

describe("RecommendationDetailPage", () => {
  function detailHandlers() {
    return {
      get: {
        [DETAIL_PATH]: () => recommendationDetail(),
      },
      getWithMeta: {},
      post: {
        [APPROVE_PATH]: () => ({ ...RECOMMENDATIONS[0], status: "APPROVED" }),
      },
    };
  }

  function renderDetail(handlers = detailHandlers()) {
    return renderApp(
      <Routes>
        <Route path="/recommendations/:id" element={<RecommendationDetailPage />} />
      </Routes>,
      { route: "/recommendations/66666666-6666-4666-8666-666666666666", handlers },
    );
  }

  it("renders the full explainability trail: evidence, calibration, timeline", async () => {
    renderDetail();
    expect(await screen.findByRole("heading", { name: "Recover Mia's abandoned cart" })).toBeInTheDocument();
    expect(screen.getByText("Evidence snapshot")).toBeInTheDocument();
    expect(screen.getByText("Cart total $48.00")).toBeInTheDocument();
    expect(screen.getByText(/agent\.revenue_recovery/)).toBeInTheDocument();
    expect(screen.getByText("Why this, why now")).toBeInTheDocument();
    expect(screen.getByText(/Carts under 24h old convert at 2\.4%/)).toBeInTheDocument();
    // Timeline with the CREATED event.
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    // Immutable-evidence promise is visible copy, not implied.
    expect(screen.getByText(/captured once, at creation/i)).toBeInTheDocument();
    // No executions yet — honest empty, not a table of ghosts.
    expect(screen.getByText("No executions recorded yet.")).toBeInTheDocument();
  });

  it("decision controls post approve from the detail view", async () => {
    const { stub } = renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: /approve recover mia's abandoned cart/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve & queue" }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/v1\/recommendations\/.+\/approve$/),
        {},
      ),
    );
  });
});

describe("AiCommandCenterPage", () => {
  function aiHandlers() {
    return {
      get: {
        "/api/v1/ai/overview": () => aiOverviewResponse(),
      },
      getWithMeta: {},
      post: {
        "/api/v1/recommendations/run": () => ({ jobId: "ai:manual:x:2" }),
      },
    };
  }

  it("zero state: never-run store gets an explained first-run CTA", async () => {
    const { stub } = renderApp(<AiCommandCenterPage />, {
      route: "/ai",
      handlers: {
        get: { "/api/v1/ai/overview": () => aiOverviewZeroState() },
        getWithMeta: {},
        post: { "/api/v1/recommendations/run": () => ({ jobId: "ai:manual:x:3" }) },
      },
    });
    expect(await screen.findByText("No analysis has run yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run your first analysis" }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/recommendations/run", {}),
    );
    expect(await screen.findByText("Analysis is running")).toBeInTheDocument();
  });

  it("live state: engine, health, pipeline, outcomes and the decision feed", async () => {
    renderApp(<AiCommandCenterPage />, { route: "/ai", handlers: aiHandlers() });
    expect(await screen.findByRole("heading", { name: "AI Command Center" })).toBeInTheDocument();
    expect(await screen.findByText("Engine status")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText("Store health")).toBeInTheDocument();
    expect(screen.getByText("Revenue trend")).toBeInTheDocument();
    expect(screen.getByText("3 abandoned carts are still open")).toBeInTheDocument();
    expect(screen.getAllByText("Awaiting decision").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Acceptance rate")).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("Decision feed")).toBeInTheDocument();
    expect(screen.getByText(/Recover Mia's abandoned cart/)).toBeInTheDocument();
    expect(screen.getAllByText("$96.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Recovered by actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run analysis now/i })).toBeInTheDocument();
  });
});

describe("AutomationPage", () => {
  function automationHandlers() {
    return {
      get: {
        "/api/v1/automation/overview": () => automationOverviewResponse(),
        "/api/v1/store": () => storeResponse(),
        "/api/v1/sync/status": () => syncStatusResponse(),
      },
      getWithMeta: {},
      patch: { "/api/v1/store/settings": () => ({ ok: true }) },
      post: {},
    };
  }

  it("renders the policy form with live guardrail values and the ledger", async () => {
    renderApp(<AutomationPage />, { route: "/automation", handlers: automationHandlers() });
    expect(await screen.findByRole("heading", { name: "Automation" })).toBeInTheDocument();
    expect(await screen.findByText("Current guardrails")).toBeInTheDocument();
    const mode = screen.getByLabelText(/autonomy mode/i);
    await waitFor(() => expect(mode).toHaveValue("MANUAL"));
    expect(screen.getByLabelText(/minimum cart value/i)).toHaveValue(0);
    // Execution ledger shows the real row with its preview summary.
    expect(screen.getByText("Win back 14 quiet customers with one email")).toBeInTheDocument();
    expect(screen.getByText(/Code PT-WINBACK14 · 14 recipients/)).toBeInTheDocument();
    expect(screen.getByText("Attributed outcomes")).toBeInTheDocument();
    // Nothing edited → save disabled (no accidental no-op writes).
    expect(screen.getByRole("button", { name: "Save automation policy" })).toBeDisabled();
  });

  it("edits and saves the policy through PATCH /store/settings", async () => {
    const { stub } = renderApp(<AutomationPage />, { route: "/automation", handlers: automationHandlers() });
    const delay = await screen.findByLabelText(/send after \(hours idle\)/i);
    await waitFor(() => expect(delay).toHaveValue(6));
    fireEvent.change(screen.getByLabelText(/autonomy mode/i), { target: { value: "SEMI_AUTOMATIC" } });
    fireEvent.change(delay, { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^discount percent$/i), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save automation policy" }));
    await waitFor(() =>
      expect(stub.calls.patch).toHaveBeenCalledWith("/api/v1/store/settings", {
        automationPreferences: {
          mode: "SEMI_AUTOMATIC",
          abandonedCart: { enabled: true, delayHours: 10, minCartValueCents: 0, discountPercent: 15 },
          autopilot: { maxDiscountPercent: 15, maxEstimatedRevenueCents: 50_000 },
        },
      }),
    );
    expect(await screen.findByText("Policy saved")).toBeInTheDocument();
  });

  it("viewers get the guardrail summary, not the switches", async () => {
    renderApp(<AutomationPage />, {
      route: "/automation",
      claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
      user: { ...TEST_USER, role: "VIEWER" },
      handlers: automationHandlers(),
    });
    await screen.findByText("Current guardrails");
    expect(screen.queryByLabelText(/autonomy mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save automation policy" })).not.toBeInTheDocument();
  });
});

/* ── M5: entitlement-denial UX + activation-funnel telemetry ─────────────── */

describe("M5 entitlement UX + funnel telemetry", () => {
  it("AI command center emits FIRST_AI_INSIGHT_VIEWED once on mount", async () => {
    const { stub } = renderApp(<AiCommandCenterPage />, {
      route: "/ai",
      handlers: {
        get: { "/api/v1/ai/overview": () => aiOverviewResponse() },
        getWithMeta: {},
        post: { "/api/v1/engagement/events": () => ({ recorded: true }) },
      },
    });
    await screen.findByText("AI Command Center");
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/engagement/events", {
        kind: "FIRST_AI_INSIGHT_VIEWED",
      }),
    );
  });

  it("an UPGRADE_REQUIRED approval denial becomes an upgrade CTA, not a plain error", async () => {
    renderApp(<RecommendationsPage />, {
      route: "/recommendations",
      handlers: {
        get: {},
        getWithMeta: { "/api/v1/recommendations": () => pagedResponse(RECOMMENDATIONS) },
        post: {
          [APPROVE_PATH]: () => {
            throw new ApiError({
              status: 403,
              code: "UPGRADE_REQUIRED",
              message: "Your trial has ended — pick a plan to keep revenue actions running",
              requestId: "req-x",
              field: null,
              details: null,
            });
          },
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /approve recover mia's abandoned cart/i }));
    await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: "Approve & queue" }));
    // Inline entitlement notice with the server's own copy + the Billing CTA.
    expect(
      await screen.findByText(/your trial has ended — pick a plan to keep revenue actions running/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view plans/i })).toHaveAttribute("href", "/billing");
    // It is NOT a crash toast.
    expect(screen.queryByText("Approval failed")).not.toBeInTheDocument();
  });
});
