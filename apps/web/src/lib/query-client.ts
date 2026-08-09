import { QueryClient } from "@tanstack/react-query";

/**
 * TanStack Query defaults (P9: fast loading without staleness traps).
 * Mutations report via toasts at the call site; queries refetch on window
 * focus (multi-user merchant teams) but never poll blindly — the realtime
 * channel replaces polling.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          failureCount < 2 && !(error instanceof Error && error.name === "ApiError" && "status" in error && ((error as unknown as { status: number }).status < 500)),
        retryDelay: (failureCount) => Math.min(8_000, 500 * 2 ** failureCount),
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
