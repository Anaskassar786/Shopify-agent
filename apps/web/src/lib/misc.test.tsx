import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderApp, TEST_USER, VIEWER_PERMISSIONS } from "../test-support/render";
import { RequireAuth, RequirePermission } from "../shell/guards";
import { QueryBoundary } from "../components/QueryBoundary";
import { createAppQueryClient } from "./query-client";
import { ApiError } from "./api-client";
import { useOnlineStatus } from "./use-online";
import { storeResponse } from "../test-support/fixtures";

describe("createAppQueryClient", () => {
  it("ships production defaults: 30s freshness, focus refetch, bounded smart retries", () => {
    const client: QueryClient = createAppQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.gcTime).toBe(300_000);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(true);
    expect(defaults.mutations?.retry).toBe(0);
    expect(typeof defaults.queries?.retry).toBe("function");
    const retry = defaults.queries?.retry as (count: number, error: unknown) => boolean;
    expect(retry(0, new Error("x"))).toBe(true);
    expect(retry(1, new Error("x"))).toBe(true);
    expect(retry(2, new Error("x"))).toBe(false);
    // Client errors are never retried; server errors are.
    expect(retry(0, new ApiError({ status: 404, code: "NOT_FOUND", message: "x", requestId: null, field: null, details: null }))).toBe(false);
    expect(retry(0, new ApiError({ status: 503, code: "SERVER_ERROR", message: "x", requestId: null, field: null, details: null }))).toBe(true);
  });
});

describe("RequireAuth", () => {
  function LocationProbe(): null {
    const location = useLocation();
    (globalThis as { __path?: string }).__path = location.pathname;
    return null;
  }

  it("renders the install gate on the standalone path", async () => {
    renderApp(
      <>
        <LocationProbe />
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/dashboard" element={<p>dashboard content</p>} />
          </Route>
        </Routes>
      </>,
      { route: "/dashboard", embedded: false, handlers: {} },
    );
    expect(await screen.findByText(/AI decision support for your Shopify store/)).toBeInTheDocument();
    expect(screen.queryByText("dashboard content")).not.toBeInTheDocument();
  });

  it("shows the branded boot state first, then the app", async () => {
    renderApp(
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/dashboard" element={<p>dashboard content</p>} />
        </Route>
      </Routes>,
      { route: "/dashboard", handlers: { get: { "/api/v1/store": () => storeResponse() } } },
    );
    expect(await screen.findByText("dashboard content")).toBeInTheDocument();
  });
});

describe("RequirePermission", () => {
  it("denies with an honest explanation and a live escape link", async () => {
    renderApp(
      <Routes>
        <Route path="/orders" element={<RequirePermission permission="orders:read"><p>orders content</p></RequirePermission>} />
        <Route path="/dashboard" element={<p>dashboard content</p>} />
      </Routes>,
      {
        route: "/orders",
        claims: { role: "VIEWER", perms: VIEWER_PERMISSIONS },
        user: { ...TEST_USER, role: "VIEWER" },
      },
    );
    expect(await screen.findByText("No access to this section")).toBeInTheDocument();
    expect(screen.queryByText("orders content")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /back to an area you can access/i }));
    expect(await screen.findByText("dashboard content")).toBeInTheDocument();
  });
});

describe("QueryBoundary", () => {
  interface QueryInput {
    readonly isPending?: boolean;
    readonly isError?: boolean;
    readonly error?: ApiError | null;
    readonly failureCount?: number;
    readonly refetch?: unknown;
  }
  const makeQuery = (input: QueryInput): Parameters<typeof QueryBoundary>[0]["query"] =>
    ({
      isPending: false,
      isError: false,
      error: null,
      failureCount: 0,
      refetch: vi.fn(() => Promise.resolve()),
      ...input,
    }) as unknown as Parameters<typeof QueryBoundary>[0]["query"];

  it("renders the loading slot while pending", () => {
    render(
      <QueryBoundary query={makeQuery({ isPending: true })} loading={<p>skeleton slot</p>}>
        <p>content</p>
      </QueryBoundary>,
    );
    expect(screen.getByText("skeleton slot")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });

  it("renders ErrorState with the request id and retries", async () => {
    const refetch = vi.fn(() => Promise.resolve());
    render(
      <QueryBoundary
        query={makeQuery({
          isError: true,
          error: new ApiError({ status: 500, code: "SERVER_ERROR", message: "database exploded", requestId: "req-999", field: null, details: null }),
          refetch,
        })}
      >
        <p>content</p>
      </QueryBoundary>,
    );
    expect(screen.getByText("Couldn't load this")).toBeInTheDocument();
    expect(screen.getByText("database exploded")).toBeInTheDocument();
    expect(screen.getByText(/req-999/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("renders the offline variant for connectivity failures without a retry button", () => {
    render(
      <QueryBoundary
        query={makeQuery({
          isError: true,
          error: new ApiError({ status: 0, code: "NETWORK_ERROR", message: "down", requestId: null, field: null, details: null }),
        })}
      >
        <p>content</p>
      </QueryBoundary>,
    );
    expect(screen.getByText("You're offline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("useOnlineStatus", () => {
  it("tracks the online/offline events", async () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    fireEvent(window, new Event("offline"));
    await waitFor(() => expect(result.current).toBe(false));
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(result.current).toBe(true));
  });
});
