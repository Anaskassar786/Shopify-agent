import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck } from "lucide-react";
import { Badge, Button, Drawer, EmptyState, ErrorState, SkeletonText, useToast } from "@profit/ui";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
} from "../lib/queries";
import type { NotificationRow } from "../lib/api-types";
import { NotificationCategories } from "../lib/api-types";

const CATEGORY_TONE: Record<string, "ai" | "info" | "warning" | "danger" | "primary" | "neutral" | "success"> = {
  [NotificationCategories.Ai]: "ai",
  [NotificationCategories.Orders]: "info",
  [NotificationCategories.Inventory]: "warning",
  [NotificationCategories.Billing]: "primary",
  [NotificationCategories.Security]: "danger",
  [NotificationCategories.Automation]: "success",
  [NotificationCategories.System]: "neutral",
};

/**
 * Right-edge notification drawer (P9). Reads the live list (already kept warm
 * by the realtime invalidation on `notification.created`), marks rows read on
 * navigation, and deep-links via the server-provided actionUrl.
 */
export function NotificationDrawer({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission("notifications:update");
  const query = useNotificationsQuery(1, false, null);
  const markRead = useMarkNotificationReadMutation();
  const markAll = useMarkAllNotificationsReadMutation();

  const openNotification = (row: NotificationRow): void => {
    if (canUpdate && row.readAt === null) markRead.mutate(row.id);
    if (row.actionUrl !== null) {
      onClose();
      navigate(row.actionUrl);
    }
  };

  const onMarkAll = (): void => {
    markAll.mutate(undefined, {
      onError: (error: ApiError) => toast.error("Could not mark all as read", error.message),
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Notifications"
      footer={
        canUpdate ? (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            iconLeft={<CheckCheck className="size-3.5" aria-hidden />}
            loading={markAll.isPending}
            disabled={(query.data?.unread ?? 0) === 0}
            onClick={onMarkAll}
          >
            Mark all as read
          </Button>
        ) : undefined
      }
    >
      {query.isPending && <SkeletonText lines={5} />}
      {query.isError && (
        <ErrorState
          body={query.error.message}
          errorId={query.error.requestId ?? undefined}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isSuccess && query.data.rows.length === 0 && (
        <EmptyState
          icon={<Bell className="size-6" aria-hidden />}
          title="You are all caught up"
          body="Sync results, security events and platform notices will land here in real time."
        />
      )}
      {query.isSuccess &&
        query.data.rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => openNotification(row)}
            className="mb-2 flex w-full items-start gap-3 rounded-lg border border-subtle bg-surface-raised/40 px-3.5 py-3 text-left transition-colors hover:border-strong focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span
              className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${row.readAt === null ? "bg-primary" : "bg-transparent"}`}
              aria-label={row.readAt === null ? "Unread" : "Read"}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-foreground">{row.title}</span>
                <span className="shrink-0 text-[10px] text-faint">{formatRelativeTime(row.createdAt)}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">{row.body}</span>
              <span className="mt-1.5 inline-block">
                <Badge tone={CATEGORY_TONE[row.category] ?? "neutral"}>{row.category}</Badge>
              </span>
            </span>
          </button>
        ))}
    </Drawer>
  );
}
