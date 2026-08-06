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

function makeFetchStub(): ReturnType<typeof vi.fn> {
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
    if (url.startsWith("/api/v1/admin/merchants")) return jsonEnvelope(200, envelope(ADMIN_MERCHANTS));
    if (url.startsWith("/api/v1/admin/ai-usage")) return jsonEnvelope(200, envelope(ADMIN_AI_USAGE));
    throw new Error(`unstubbed admin fetch: ${url} headers=${JSON.stringify(headers)}`);
  });
}

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
    const adminCalls = stub.mock.calls.filter((call) => String(call[0]).startsWith("/api/v1/admin"));
    expect(adminCalls.length).toBeGreaterThanOrEqual(2); // gate probe + overview query
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
