import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, REFRESH_STORAGE_KEY, useAuth, type AuthContextValue } from "./auth-context";
import { createStubClient, makeJwt, TEST_USER } from "../test-support/render";
import { ApiError } from "./api-client";

function makeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

let latest: AuthContextValue | null = null;
function Probe(): null {
  latest = useAuth();
  return null;
}

function renderAuth(options: {
  readonly storage?: Storage;
  readonly embeddedToken?: string | null;
  readonly stub: ReturnType<typeof createStubClient>;
}) {
  latest = null;
  render(
    <AuthProvider
      storage={options.storage}
      sessionTokenProvider={() => Promise.resolve(options.embeddedToken ?? null)}
      clientFactory={() => options.stub.client}
    >
      <Probe />
      <p>app content</p>
    </AuthProvider>,
  );
}

const NOT_FOUND = (): never => {
  throw new ApiError({ status: 404, code: "X", message: "x", requestId: null, field: null, details: null });
};

describe("AuthProvider boot", () => {
  it("embedded session token → session exchange → ready with claims + user", async () => {
    const accessToken = makeJwt({ role: "OWNER", perms: ["analytics:read"] });
    const stub = createStubClient({
      postPublic: {
        "/api/v1/auth/session": () => ({ accessToken, refreshToken: "r1", accessTokenExpiresIn: 3600, user: TEST_USER }),
      },
      post: {},
      get: {},
    });
    const storage = makeStorage();
    renderAuth({ storage, embeddedToken: "embedded-token", stub });

    await waitFor(() => expect(latest?.status).toBe("ready"));
    expect(latest?.user?.fullName).toBe("Ana Rivera");
    expect(latest?.claims?.role).toBe("OWNER");
    expect(latest?.hasPermission("analytics:read")).toBe(true);
    expect(latest?.hasPermission("billing:manage")).toBe(false);
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("r1");
    expect(stub.calls.postPublic).toHaveBeenCalledWith("/api/v1/auth/session", { sessionToken: "embedded-token" });
  });

  it("falls back to a stored refresh token when no embedded token exists", async () => {
    const accessToken = makeJwt({ role: "VIEWER", perms: ["store:read"] });
    const exchange = vi.fn(NOT_FOUND);
    const stub = createStubClient({
      postPublic: {
        "/api/v1/auth/session": exchange,
        "/api/v1/auth/refresh": () => ({ accessToken, refreshToken: "r2", accessTokenExpiresIn: 3600 }),
      },
    });
    const storage = makeStorage({ [REFRESH_STORAGE_KEY]: "old-refresh" });
    renderAuth({ storage, embeddedToken: null, stub });

    await waitFor(() => expect(latest?.status).toBe("ready"));
    expect(exchange).not.toHaveBeenCalled();
    expect(latest?.claims?.role).toBe("VIEWER");
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("r2");
  });

  it("goes standalone with neither token nor refresh", async () => {
    const stub = createStubClient({});
    renderAuth({ storage: makeStorage(), embeddedToken: null, stub });
    await waitFor(() => expect(latest?.status).toBe("standalone"));
    expect(latest?.accessToken).toBeNull();
  });

  it("session-exchange failure consumes the stored refresh before standalone", async () => {
    const stub = createStubClient({
      postPublic: {
        "/api/v1/auth/session": NOT_FOUND,
        "/api/v1/auth/refresh": NOT_FOUND,
      },
    });
    const storage = makeStorage({ [REFRESH_STORAGE_KEY]: "dying-refresh" });
    renderAuth({ storage, embeddedToken: "embedded-token", stub });
    await waitFor(() => expect(latest?.status).toBe("standalone"));
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
  });

  it("signOut clears state and the stored refresh", async () => {
    const accessToken = makeJwt({});
    const stub = createStubClient({
      postPublic: {
        "/api/v1/auth/session": () => ({ accessToken, refreshToken: "r1", accessTokenExpiresIn: 3600, user: TEST_USER }),
      },
    });
    const storage = makeStorage();
    renderAuth({ storage, embeddedToken: "embedded-token", stub });
    await waitFor(() => expect(latest?.status).toBe("ready"));
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBe("r1");

    act(() => latest?.signOut());
    expect(latest?.status).toBe("standalone");
    expect(storage.getItem(REFRESH_STORAGE_KEY)).toBeNull();
    expect(screen.getByText("app content")).toBeInTheDocument();
  });
});
