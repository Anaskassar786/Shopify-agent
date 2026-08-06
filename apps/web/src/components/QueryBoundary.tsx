import { useEffect, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { ErrorState, SkeletonText } from "@profit/ui";
import { ApiError } from "../lib/api-client";
import { isOfflineError, useOnlineStatus } from "../lib/use-online";

/**
 * The single loading/error/offline policy for every data-driven block (user
 * requirement: every page gracefully handles loading, empty, error, offline).
 *   pending  → caller-provided skeleton
 *   offline  → honest "you're offline" state, auto-refetch on reconnect
 *   error    → ErrorState with the server request id + retry
 *   success  → children (the owning page renders empty states explicitly —
 *              empty is content, not a boundary condition)
 */
export interface QueryBoundaryProps {
  readonly query: Pick<UseQueryResult<unknown, ApiError>, "isPending" | "isError" | "error" | "refetch" | "failureCount">;
  readonly children: ReactNode;
  readonly loading?: ReactNode;
  /** Compact copy for small widgets. */
  readonly compact?: boolean;
}

export function QueryBoundary({ query, children, loading, compact = false }: QueryBoundaryProps): ReactNode {
  const online = useOnlineStatus();

  // Back online → silently re-pull the failed resource.
  useEffect(() => {
    if (online && query.isError && isOfflineError(query.error)) {
      void query.refetch();
    }
  }, [online, query]);

  if (query.isPending) {
    return loading !== undefined ? loading : <SkeletonText lines={compact ? 2 : 4} />;
  }

  if (query.isError && query.error !== null) {
    const error: ApiError = query.error;
    const offline = isOfflineError(error) || !online;
    return (
      <ErrorState
        title={offline ? "You're offline" : "Couldn't load this"}
        body={
          offline
            ? "The connection to your store's data dropped. It will refresh by itself the moment you're back online."
            : error.message
        }
        errorId={error.requestId ?? undefined}
        onRetry={offline ? undefined : () => void query.refetch()}
        className={compact ? "py-6" : undefined}
      />
    );
  }

  return children;
}

/** Offline banner icon used by the shell-level connectivity strip. */
export function OfflineIcon(): ReactNode {
  return <CloudOff className="size-3.5" aria-hidden />;
}
