import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, SkeletonText } from "@profit/ui";
import { AdminTabs } from "./AdminTabs";
import { useAdminRefresh } from "../lib/admin-queries";

/**
 * Shared admin-view chrome: tabs + refresh + loading/error/empty handling.
 * The admin tree has no QueryBoundary (that component lives in the merchant
 * shell and assumes offline semantics the standalone console doesn't have) —
 * this is the same discipline, scaled to three read-only views.
 */
export function AdminView({
  title,
  subtitle,
  query,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly query: Pick<UseQueryResult<unknown, unknown>, "isPending" | "isError" | "error" | "refetch">;
  readonly children: ReactNode;
}): ReactNode {
  const refreshAll = useAdminRefresh();
  return (
    <div>
      <AdminTabs />
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<RefreshCw className="size-3.5" aria-hidden />}
          onClick={refreshAll}
        >
          Refresh
        </Button>
      </div>
      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-label="Loading admin data">
          <SkeletonText lines={2} className="max-w-md" />
          <SkeletonText lines={6} />
        </div>
      ) : query.isError ? (
        <ErrorState
          title="Admin data could not be loaded"
          body={query.error instanceof Error ? query.error.message : "The admin API did not answer as expected."}
          onRetry={() => void query.refetch()}
        />
      ) : (
        children
      )}
    </div>
  );
}

export function AdminEmpty({ title, body }: { readonly title: string; readonly body: string }): ReactNode {
  return <EmptyState title={title} body={body} />;
}
