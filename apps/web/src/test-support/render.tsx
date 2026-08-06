import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@profit/ui";
import type { ApiMeta } from "@profit/types";
import { vi, type Mock } from "vitest";
import { ApiError, type ApiClient, type DataWithMeta } from "../lib/api-client";
import { AuthProvider, type AppUser } from "../lib/auth-context";

/**
 * Hermetic app harness: every provider the real tree has, backed by a fully
 * stubbed ApiClient (per-path handlers). Identical composition to main.tsx so
 * tests exercise the same wiring production does — minus the network.
 */

export const OWNER_PERMISSIONS = [
  "store:read",
  "store:update",
  "settings:update",
  "products:read",
  "products:sync",
  "customers:read",
  "customers:sync",
  "orders:read",
  "orders:sync",
  "inventory:read",
  "inventory:sync",
  "collections:sync",
  "discounts:sync",
  "metafields:sync",
  "analytics:read",
  "recommendations:read",
  "recommendations:approve",
  "recommendations:reject",
  "automation:read",
  "automation:manage",
  "notifications:read",
  "notifications:update",
  "billing:read",
  "billing:manage",
  "audit:read",
  "users:read",
  "users:manage",
  "apikeys:manage",
] as const;

export const VIEWER_PERMISSIONS = [
  "store:read",
  "analytics:read",
  "recommendations:read",
  "notifications:read",
] as const;

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Unsigned JWT with the real claim layout — the client only decodes (server verifies). */
export function makeJwt(claims: { sub?: string; storeId?: string; role?: string; perms?: readonly string[] } = {}): string {
  const payload = {
    sub: claims.sub ?? "11111111-1111-4111-8111-111111111111",
    storeId: claims.storeId ?? "22222222-2222-4222-8222-222222222222",
    role: claims.role ?? "OWNER",
    perms: [...(claims.perms ?? OWNER_PERMISSIONS)],
    exp: 4_102_444_800,
  };
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(payload)}.${base64url("signature")}`;
}

export const TEST_USER: AppUser = {
  id: "11111111-1111-4111-8111-111111111111",
  fullName: "Ana Rivera",
  email: "ana@example.com",
  role: "OWNER",
};

export type PathHandler = (input: unknown) => unknown | Promise<unknown>;

export interface StubHandlers {
  readonly get?: Record<string, PathHandler>;
  readonly getWithMeta?: Record<string, PathHandler>;
  readonly post?: Record<string, PathHandler>;
  readonly patch?: Record<string, PathHandler>;
  readonly postPublic?: Record<string, PathHandler>;
}

export interface StubClient {
  readonly client: ApiClient;
  readonly calls: {
    readonly get: Mock;
    readonly getWithMeta: Mock;
    readonly post: Mock;
    readonly patch: Mock;
    readonly postPublic: Mock;
  };
}

function notStubbed(method: string): PathHandler {
  return () => {
    throw new ApiError({
      status: 500,
      code: "UNSTUBBED_ENDPOINT",
      message: `No stub registered for ${method} path`,
      requestId: "req-test",
      field: null,
      details: null,
    });
  };
}

/** Builds a structurally-exact ApiClient double (its public methods, vi.fn-tracked). */
export function createStubClient(handlers: StubHandlers): StubClient {
  const resolve = async (table: Record<string, PathHandler> | undefined, method: string, path: string, input: unknown): Promise<unknown> => {
    const key = Object.keys(table ?? {}).find((candidate) => path === candidate || path.startsWith(`${candidate}?`));
    if (key === undefined) throw new ApiError({ status: 404, code: "UNSTUBBED_ENDPOINT", message: `${method} ${path} not stubbed`, requestId: "req-test", field: null, details: null });
    const handler = (table ?? {})[key] ?? notStubbed(method);
    return handler(input);
  };

  const calls = {
    get: vi.fn((path: string, params?: Record<string, string | number | boolean | undefined>) =>
      resolve(handlers.get, "GET", path, params),
    ),
    getWithMeta: vi.fn((path: string, params?: Record<string, string | number | boolean | undefined>) =>
      resolve(handlers.getWithMeta, "GET(meta)", path, params),
    ),
    post: vi.fn((path: string, body?: unknown) => resolve(handlers.post, "POST", path, body)),
    patch: vi.fn((path: string, body?: unknown) => resolve(handlers.patch, "PATCH", path, body)),
    postPublic: vi.fn((path: string, body?: unknown) => resolve(handlers.postPublic, "POST(public)", path, body)),
  };

  return { client: calls as unknown as ApiClient, calls };
}

/** Envelope-shaped list response for getWithMeta stubs. */
export function pagedResponse<T>(items: readonly T[], totalItems?: number, extras?: Record<string, unknown>): DataWithMeta<readonly T[]> {
  return {
    data: items,
    meta: {
      pagination: { page: 1, pageSize: 25, totalItems: totalItems ?? items.length, totalPages: 1 },
      ...(extras !== undefined ? { extras } : {}),
    } satisfies ApiMeta,
  };
}

export interface RenderOptions {
  readonly handlers?: StubHandlers;
  readonly claims?: { readonly role?: string; readonly perms?: readonly string[] };
  readonly user?: AppUser;
  readonly route?: string;
  /** When false, boots without an embedded token (→ refresh/standalone path). */
  readonly embedded?: boolean;
}

export interface RenderResult {
  readonly stub: StubClient;
  readonly unmount: () => void;
}

/**
 * Full provider tree + MemoryRouter. Callers await specific content via
 * testing-library `findBy*` — the auth boot resolves inside `act`.
 */
export function renderApp(ui: ReactNode, options: RenderOptions = {}): RenderResult {
  const accessToken = makeJwt(options.claims ?? {});
  const user = options.user ?? TEST_USER;
  const stub = createStubClient({
    ...options.handlers,
    postPublic: {
      "/api/v1/auth/session": () => ({
        accessToken,
        refreshToken: "refresh-token-1",
        accessTokenExpiresIn: 3600,
        user,
      }),
      "/api/v1/auth/refresh": () => ({
        accessToken,
        refreshToken: "refresh-token-2",
        accessTokenExpiresIn: 3600,
      }),
      ...(options.handlers?.postPublic ?? {}),
    },
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  const storage = new Map<string, string>();
  const memoryStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  } as Storage;

  const embedded = options.embedded ?? true;
  const view = render(
    <ThemeProvider storage={memoryStorage}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider
            storage={memoryStorage}
            sessionTokenProvider={() => Promise.resolve(embedded ? "embedded.session.token" : null)}
            clientFactory={() => stub.client}
          >
            <MemoryRouter initialEntries={[options.route ?? "/dashboard"]}>{ui}</MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );

  return { stub, unmount: () => view.unmount() };
}
