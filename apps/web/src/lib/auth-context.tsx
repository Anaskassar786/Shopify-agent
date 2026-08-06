import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClient } from "./api-client";
import { claimsFromAccessToken, getShopifySessionToken, type JwtAppClaims } from "./shopify";

/**
 * First-party auth (M1 contract). Boot order, permanently:
 *   1. Embedded session token (App Bridge) → POST /auth/session → token pair;
 *   2. else stored refresh token → POST /auth/refresh (rotation) → new pair;
 *   3. else "standalone" — the install gate renders (robust outside Shopify).
 * Access tokens live in memory only; the refresh token is persisted
 * (rotation + reuse-kill on the server makes theft self-limiting).
 */

export const REFRESH_STORAGE_KEY = "profit.refresh.v1";

export interface AppUser {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: string;
}

export interface AuthState {
  readonly status: "booting" | "ready" | "standalone";
  readonly claims: JwtAppClaims | null;
  readonly user: AppUser | null;
  readonly accessToken: string | null;
}

export interface AuthContextValue extends AuthState {
  readonly signOut: () => void;
  readonly hasPermission: (permission: string) => boolean;
}

interface SessionResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly user: AppUser;
}

interface RefreshResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredRefreshToken(storage: Storage | undefined): string | null {
  return storage?.getItem(REFRESH_STORAGE_KEY) ?? null;
}

export interface AuthProviderProps {
  readonly children: ReactNode;
  readonly storage?: Storage | undefined;
  /** Bootstraps the embedded session token (App Bridge in prod; injectable). */
  readonly sessionTokenProvider?: () => Promise<string | null>;
  /** Creates the client (injectable for hermetic tests). */
  readonly clientFactory?: (options: {
    getAccessToken: () => string | null;
    refreshAccessToken: () => Promise<string | null>;
  }) => ApiClient;
  readonly onClientReady?: (client: ApiClient) => void;
}

export function AuthProvider({
  children,
  storage,
  sessionTokenProvider = getShopifySessionToken,
  clientFactory = (options) => new ApiClient(options),
  onClientReady,
}: AuthProviderProps): ReactNode {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const sessionProviderRef = useRef(sessionTokenProvider);
  sessionProviderRef.current = sessionTokenProvider;

  const [state, setState] = useState<AuthState>({
    status: "booting",
    claims: null,
    user: null,
    accessToken: null,
  });
  const tokenRef = useRef<string | null>(null);
  const userRef = useRef<AppUser | null>(null);

  const applySession = useCallback(
    (input: { accessToken: string; refreshToken: string; user: AppUser | null }): boolean => {
      const claims = claimsFromAccessToken(input.accessToken);
      if (claims === null) return false;
      tokenRef.current = input.accessToken;
      if (input.user !== null) userRef.current = input.user;
      store?.setItem(REFRESH_STORAGE_KEY, input.refreshToken);
      setState({
        status: "ready",
        claims,
        user: userRef.current,
        accessToken: input.accessToken,
      });
      return true;
    },
    [store],
  );

  const clientRef = useRef<ApiClient | null>(null);
  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    const client = clientRef.current;
    const refreshToken = readStoredRefreshToken(store);
    if (client === null || refreshToken === null) return null;
    try {
      const refreshed = await client.postPublic<RefreshResponse>("/api/v1/auth/refresh", {
        refreshToken,
      });
      const ok = applySession({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        user: null,
      });
      return ok ? refreshed.accessToken : null;
    } catch {
      store?.removeItem(REFRESH_STORAGE_KEY);
      return null;
    }
  }, [applySession, store]);

  if (clientRef.current === null) {
    clientRef.current = clientFactory({
      getAccessToken: () => tokenRef.current,
      refreshAccessToken,
    });
    onClientReady?.(clientRef.current);
  }

  useEffect(() => {
    let cancelled = false;
    const boot = async (): Promise<void> => {
      const client = clientRef.current;
      if (client === null) return;
      const embeddedToken = await sessionProviderRef.current();
      if (embeddedToken !== null) {
        try {
          const session = await client.postPublic<SessionResponse>("/api/v1/auth/session", {
            sessionToken: embeddedToken,
          });
          if (!cancelled) {
            applySession({
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              user: session.user,
            });
          }
          return;
        } catch {
          // Embedded exchange failed (token expired mid-flight etc.) — fall
          // through to the stored refresh token before declaring standalone.
        }
      }
      if (cancelled) return;
      const hadRefresh = readStoredRefreshToken(store) !== null;
      const refreshed = await refreshAccessToken();
      if (cancelled) return;
      if (refreshed === null) {
        setState((prev) => ({
          ...prev,
          status: hadRefresh ? "standalone" : "standalone",
          accessToken: null,
          claims: null,
        }));
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = useCallback(() => {
    tokenRef.current = null;
    userRef.current = null;
    store?.removeItem(REFRESH_STORAGE_KEY);
    setState({ status: "standalone", claims: null, user: null, accessToken: null });
  }, [store]);

  const hasPermission = useCallback(
    (permission: string): boolean => state.claims?.permissions.includes(permission) ?? false,
    [state.claims],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signOut, hasPermission }),
    [state, signOut, hasPermission],
  );

  const client = clientRef.current;

  return (
    <AuthContext.Provider value={value}>
      <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export const ApiClientContext = createContext<ApiClient | null>(null);

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) throw new Error("useApiClient must be used inside <AuthProvider>");
  return client;
}
