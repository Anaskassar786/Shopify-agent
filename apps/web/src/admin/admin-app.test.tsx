import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@profit/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "./AdminApp";
import { ADMIN_AI_USAGE, ADMIN_MERCHANTS, adminOverviewFixture } from "../test-support/fixtures";

/**
 * M5 Super Admin console contracts: the key gate is REAL (probes the live
 * admin API before revealing anything), the key never touches storage, and
 * the three read-only views render the cross-tenant wires as-is. fetch is the
 * only stubbed edge — the admin tree deliberately has no ApiClient/session.
 */

const ADMIN_HEADERS = { Accept: "application/json", "X-Platform-Admin-Key": "correct-key" };

const SESSION_TOKEN = "v1.test-session-token";
const VALID_OPERATOR = "ravi@profit";

/** Admin merchant shape mirrored from fixtures (ADMIN_MERCHANTS[0]). */
const FIRST_STORE_ID = ADMIN_MERCHANTS[0]!.storeId;

function makeFetchStub(accessOverrides: () => readonly unknown[] = () => []): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorized = headers["X-Platform-Admin-Key"] === "correct-key";
    if (!authorized && url.startsWith("/api/v1/admin")) {
      return jsonEnvelope(401, {
        success: false,
        errors: [{ code: "AUTHENTICATION_FAILED", message: "Valid platform admin key required" }],
      });
    }
    if (url.startsWith("/api/v1/admin/overview")) return jsonEnvelope(200, envelope(adminOverviewFixture()));
    if (url.startsWith("/api/v1/admin/merchants") && url.includes("trial-extension")) {
      return jsonEnvelope(200, envelope({ id: "sub-1", storeId: FIRST_STORE_ID, planId: "p1", status: "TRIALING", shopifyChargeId: null, billingInterval: null, trialEndsAt: "2026-08-25T00:00:00.000Z", currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, cancelledAt: null }));
    }
    if (url.startsWith("/api/v1/admin/merchants") && url.includes("access-overrides")) {
      return jsonEnvelope(200, envelope(accessOverrides()));
    }
    if (url.startsWith("/api/v1/admin/merchants")) return jsonEnvelope(200, envelope(ADMIN_MERCHANTS));
    if (url.startsWith("/api/v1/admin/ai-usage")) return jsonEnvelope(200, envelope(ADMIN_AI_USAGE));
    if (url.startsWith("/api/v1/admin/tickets/")) {
      return jsonEnvelope(200, envelope({ ticket: ADMIN_TICKETS.rows[0], messages: ADMIN_MESSAGES }));
    }
    if (url.startsWith("/api/v1/admin/tickets")) return jsonEnvelope(200, envelope(ADMIN_TICKETS));
    if (url.startsWith("/api/v1/admin/actions")) return jsonEnvelope(200, envelope(ADMIN_ACTIONS));
    if (url === "/api/v1/admin/session") {
      return jsonEnvelope(201, envelope({ token: SESSION_TOKEN, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), operatorId: VALID_OPERATOR }));
    }
    throw new Error(`unstubbed admin fetch: ${url} headers=${JSON.stringify(headers)}`);
  });
}

const ADMIN_TICKETS = {
  rows: [
    {
      id: "tkt-1",
      openedByUserId: "u-1",
      subject: "Orders export missing rows",
      category: "DATA",
      priority: "HIGH",
      status: "OPEN",
      messageCount: 1,
      lastMessageAt: "2026-08-06T09:00:00.000Z",
      assignedOperator: null,
      operatorAttention: true,
      resolvedAt: null,
      closedAt: null,
      createdAt: "2026-08-06T09:00:00.000Z",
      updatedAt: "2026-08-06T09:00:00.000Z",
      shopDomain: "brass-city-lights.myshopify.com",
      storeName: "Brass City Lights",
      openerEmail: "owner@brasscity.example",
    },
  ],
  total: 1,
};

const ADMIN_MESSAGES = [
  {
    id: "msg-1",
    authorKind: "MERCHANT",
    authorUserId: "u-1",
    authorOperator: null,
    authorEmail: "owner@brasscity.example",
    body: "The orders export stopped at 200 rows.",
    createdAt: "2026-08-06T09:00:00.000Z",
  },
];

const ADMIN_ACTIONS = [
  {
    id: "act-1",
    storeId: FIRST_STORE_ID,
    operatorId: VALID_OPERATOR,
    action: "EXTEND_TRIAL",
    targetType: "subscription",
    targetId: "sub-1",
    payloadHash: "0123456789abcdef0123456789abcdef",
    ip: "10.1.2.3",
    createdAt: "2026-08-07T08:00:00.000Z",
  },
];

const ACTIVE_OVERRIDE = {
  id: "ovr-1",
  storeId: FIRST_STORE_ID,
  kind: "COMP_ACCESS",
  accessUntil: "2026-08-20T00:00:00.000Z",
  grantedBy: VALID_OPERATOR,
  reason: "Season launch bridge",
  grantedAt: "2026-08-01T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

function envelope<T>(data: T): unknown {
  return { success: true, data };
}

function jsonEnvelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderAdmin(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
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
  render(tree);
}

async function unlock(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/platform admin key/i), { target: { value: "correct-key" } });
  fireEvent.click(screen.getByRole("button", { name: /unlock console/i }));
  await screen.findByText("Platform overview");
}

describe("AdminApp (M5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gates on the key, rejects wrong keys with the server's message, and never persists it", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    expect(screen.getByText(/access is key-gated and fully audit-logged/i)).toBeInTheDocument();

    // Wrong key → the 401 AUTHENTICATION_FAILED path keeps the gate shut.
    fireEvent.change(screen.getByLabelText(/platform admin key/i), { target: { value: "wrong-key" } });
    fireEvent.click(screen.getByRole("button", { name: /unlock console/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected/i);
    expect(screen.queryByText("Platform overview")).not.toBeInTheDocument();
    // Memory-only: nothing was written to any web storage.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("sends the key as X-Platform-Admin-Key on every admin request", async () => {
    const stub = makeFetchStub();
    vi.stubGlobal("fetch", stub);
    renderAdmin();
    await unlock();
    // The shell heading can render a tick before the overview query fires —
    // wait for the call count, then assert the header on every request.
    await waitFor(() =>
      expect(stub.mock.calls.filter((call) => String(call[0]).startsWith("/api/v1/admin")).length).toBeGreaterThanOrEqual(2), // gate probe + overview query
    );
    const adminCalls = stub.mock.calls.filter((call) => String(call[0]).startsWith("/api/v1/admin"));
    for (const [, init] of adminCalls) {
      expect((init?.headers as Record<string, string>)["X-Platform-Admin-Key"]).toBe(
        ADMIN_HEADERS["X-Platform-Admin-Key"],
      );
    }
  });

  it("renders the overview: merchants, modeled MRR, queue health, activation funnel", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    await unlock();
    expect(await screen.findByText("Modeled MRR")).toBeInTheDocument();
    expect(screen.getByText("$18,200.00")).toBeInTheDocument();
    expect(screen.getByText(/3 running/)).toBeInTheDocument();
    expect(screen.getByText("First sync completed")).toBeInTheDocument();
    expect(screen.getByText("Paid subscription")).toBeInTheDocument();
    expect(screen.getByText("92.7% from previous step")).toBeInTheDocument();
  });

  it("navigates to merchants and renders plan + billing columns with real figures", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    await unlock();
    fireEvent.click(screen.getByRole("link", { name: "Merchants" }));
    expect(await screen.findByText("Brass City Lights")).toBeInTheDocument();
    expect(screen.getByText("GROWTH")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("$1,845.00")).toBeInTheDocument(); // attributed revenue
  });

  it("renders the AI usage totals and per-store ledger rows", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    await unlock();
    fireEvent.click(screen.getByRole("link", { name: "AI usage" }));
    expect(await screen.findByText("AI usage by store")).toBeInTheDocument();
    // Data-text assertions are awaited: the header renders during the pending state.
    expect(await screen.findByText("240")).toBeInTheDocument(); // total calls 214 + 26
    expect(screen.getByText("$3.66")).toBeInTheDocument(); // total metered cost
    expect(screen.getByText("brass-city-lights.myshopify.com")).toBeInTheDocument();
  });
});

/* ── M6: step-up session + write surface ─────────────────────────────────── */

async function unlockWrites(stub: ReturnType<typeof vi.fn>): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /unlock write actions/i }));
  fireEvent.change(screen.getByLabelText("Operator identity"), { target: { value: VALID_OPERATOR } });
  fireEvent.change(screen.getByLabelText("Session reason"), { target: { value: "support shift IN-42" } });
  fireEvent.click(screen.getByRole("button", { name: /open operator session/i }));
  await screen.findByText("Write actions unlocked");
  void stub;
}

describe("AdminApp (M6): step-up session gates every write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("opens an operator session: POST /session with identity+reason, chip shows, storage only holds the session", async () => {
    const stub = makeFetchStub();
    vi.stubGlobal("fetch", stub);
    renderAdmin();
    await unlock();
    await unlockWrites(stub);

    const sessionCall = stub.mock.calls.find((call) => String(call[0]) === "/api/v1/admin/session");
    expect(sessionCall).toBeDefined();
    const [, init] = sessionCall!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ operatorId: VALID_OPERATOR, reason: "support shift IN-42" });
    expect(screen.getAllByText(/operator ravi@profit/i).length).toBeGreaterThanOrEqual(1);
    // Only the session lives in storage — the admin KEY never does (M5 rule).
    for (const key of Object.keys(window.sessionStorage)) {
      expect(key).toBe("profit.adminSession.v1");
    }
    expect(window.localStorage.length).toBe(0);
  });

  it("tickets inbox: reads render cross-tenant context; reply posts with BOTH headers when unlocked", async () => {
    const stub = makeFetchStub();
    vi.stubGlobal("fetch", stub);
    renderAdmin();
    await unlock();
    fireEvent.click(screen.getByRole("link", { name: "Tickets" }));
    fireEvent.click(await screen.findByText("Orders export missing rows"));
    // Wait for the thread drawer specifically (the list cell also shows the domain).
    await screen.findByRole("dialog");
    expect(await screen.findAllByText(/brass-city-lights\.myshopify\.com/)).not.toHaveLength(0);

    // Without the session the write controls are honestly disabled.
    expect(await screen.findByRole("button", { name: /^resolve$/i })).toBeDisabled();

    await unlockWrites(stub);
    fireEvent.change(screen.getByLabelText("Operator reply"), { target: { value: "Found it — the page cursor skipped closed orders. Fixed." } });
    fireEvent.click(screen.getByRole("button", { name: /send reply/i }));
    await waitFor(() => {
      const replyCall = stub.mock.calls.find((call) => String(call[0]).includes("/api/v1/admin/tickets/tkt-1/reply"));
      expect(replyCall).toBeDefined();
      const [, init] = replyCall!;
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Platform-Admin-Key"]).toBe("correct-key");
      expect(headers["X-Admin-Session"]).toBe(SESSION_TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual({ body: "Found it — the page cursor skipped closed orders. Fixed." });
    });
  });

  it("account actions: extend trial posts additionalDays + reason with the session header", async () => {
    const stub = makeFetchStub();
    vi.stubGlobal("fetch", stub);
    renderAdmin();
    await unlock();
    await unlockWrites(stub);

    fireEvent.click(screen.getByRole("link", { name: "Account actions" }));
    fireEvent.change(await screen.findByLabelText("Store for account actions"), { target: { value: FIRST_STORE_ID } });
    fireEvent.change(screen.getByLabelText("Trial extension reason"), { target: { value: "Merchant launch slipped a week" } });
    fireEvent.change(screen.getByLabelText("Extra trial days"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /extend by 14 days/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm, operator/i }));

    await waitFor(() => {
      const call = stub.mock.calls.find((c) => String(c[0]).includes(`/api/v1/admin/merchants/${FIRST_STORE_ID}/trial-extension`));
      expect(call).toBeDefined();
      const [, init] = call!;
      expect((init?.headers as Record<string, string>)["X-Admin-Session"]).toBe(SESSION_TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual({
        storeId: FIRST_STORE_ID,
        additionalDays: 14,
        reason: "Merchant launch slipped a week",
      });
    });
  });

  it("action log renders the operator provenance columns", async () => {
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    await unlock();
    fireEvent.click(screen.getByRole("link", { name: "Action log" }));
    expect(await screen.findByText("EXTEND_TRIAL")).toBeInTheDocument();
    expect(screen.getByText("ravi@profit")).toBeInTheDocument();
    expect(screen.getByText("10.1.2.3")).toBeInTheDocument();
    expect(screen.getByText("0123456789ab…")).toBeInTheDocument();
  });

  it("account actions: grant posts kind + ISO window with the session header; revoke closes the loop", async () => {
    const stub = makeFetchStub(() => [ACTIVE_OVERRIDE]);
    vi.stubGlobal("fetch", stub);
    renderAdmin();
    await unlock();
    await unlockWrites(stub);

    fireEvent.click(screen.getByRole("link", { name: "Account actions" }));
    fireEvent.change(await screen.findByLabelText("Store for account actions"), { target: { value: FIRST_STORE_ID } });

    // Existing window renders with its provenance and active state.
    expect(await screen.findByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("Season launch bridge")).toBeInTheDocument();

    // Grant: kind switches the help copy; the window serializes to ISO.
    fireEvent.change(screen.getByLabelText("Override kind"), { target: { value: "CHARGE_FAILURE_GRACE" } });
    expect(screen.getByText(/Bridges a failed Shopify charge/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Access until"), { target: { value: "2026-08-20T10:30" } });
    fireEvent.change(screen.getByLabelText("Override reason"), { target: { value: "Ticket IN-42 charge retry window" } });
    fireEvent.click(screen.getByRole("button", { name: /grant override/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm, operator/i }));

    await waitFor(() => {
      const call = stub.mock.calls.find(
        (c) => String(c[0]).includes(`/api/v1/admin/merchants/${FIRST_STORE_ID}/access-overrides`) && (c[1]?.method ?? "GET") === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call!;
      expect((init?.headers as Record<string, string>)["X-Admin-Session"]).toBe(SESSION_TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual({
        storeId: FIRST_STORE_ID,
        kind: "CHARGE_FAILURE_GRACE",
        accessUntil: new Date("2026-08-20T10:30").toISOString(),
        reason: "Ticket IN-42 charge retry window",
      });
    });
    expect(await screen.findByText("Access override granted")).toBeInTheDocument();

    // Revoke: the reason rides along; the store re-gates immediately.
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    fireEvent.change(await screen.findByLabelText("Revoke reason"), { target: { value: "Merchant fixed the card" } });
    fireEvent.click(screen.getByRole("button", { name: /revoke access/i }));

    await waitFor(() => {
      const call = stub.mock.calls.find((c) => String(c[0]).includes(`/access-overrides/${ACTIVE_OVERRIDE.id}/revoke`));
      expect(call).toBeDefined();
      const [, init] = call!;
      expect((init?.headers as Record<string, string>)["X-Admin-Session"]).toBe(SESSION_TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual({ reason: "Merchant fixed the card" });
    });
    expect(await screen.findByText("Override revoked")).toBeInTheDocument();
  });

  it("a stale/expired stored session is dropped on boot (still gated)", async () => {
    window.sessionStorage.setItem(
      "profit.adminSession.v1",
      JSON.stringify({ token: "dead", operatorId: "old@profit", expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    vi.stubGlobal("fetch", makeFetchStub());
    renderAdmin();
    await unlock();
    expect(screen.getByRole("button", { name: /unlock write actions/i })).toBeInTheDocument();
    expect(screen.queryByText(/operator old@profit/i)).not.toBeInTheDocument();
  });
});
