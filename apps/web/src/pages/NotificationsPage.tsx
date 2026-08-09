import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck } from "lucide-react";
import type { NotificationCategory } from "@profit/types";
import { Badge, Button, Card, CardBody, EmptyState, Select, Tabs, useToast, type BadgeTone } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import {
  useMarkAllNotificationsReadMutation,
  useMarkNotificationReadMutation,
  useNotificationsQuery,
} from "../lib/queries";
import { NotificationCategories } from "../lib/api-types";

const CATEGORY_TONE: Record<string, BadgeTone> = {
  [NotificationCategories.Ai]: "ai",
  [NotificationCategories.Orders]: "info",
  [NotificationCategories.Inventory]: "warning",
  [NotificationCategories.Billing]: "primary",
  [NotificationCategories.Security]: "danger",
  [NotificationCategories.Automation]: "success",
  [NotificationCategories.System]: "neutral",
};

const CATEGORY_OPTIONS = [
  "",
  NotificationCategories.Ai,
  NotificationCategories.Orders,
  NotificationCategories.Inventory,
  NotificationCategories.Billing,
  NotificationCategories.Security,
  NotificationCategories.Automation,
  NotificationCategories.System,
] as const;

export function NotificationsPage(): ReactNode {
  const navigate = useNavigate();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission("notifications:update");
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [page, setPage] = useState(1);

  const notifications = useNotificationsQuery(page, tab === "unread", category);
  const markRead = useMarkNotificationReadMutation();
  const markAll = useMarkAllNotificationsReadMutation();

  const totalPages = notifications.data?.pagination.totalPages ?? 1;

  const onMarkAll = (): void => {
    markAll.mutate(undefined, {
      onSuccess: () => toast.success("All caught up", "Every notification is marked as read."),
      onError: (error: ApiError) => toast.error("Could not mark all as read", error.message),
    });
  };

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="Platform events delivered in real time — sync results, security, billing and system notices."
        actions={
          canUpdate ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<CheckCheck className="size-3.5" aria-hidden />}
              loading={markAll.isPending}
              disabled={(notifications.data?.unread ?? 0) === 0}
              onClick={onMarkAll}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          items={[
            { key: "all", label: "All" },
            { key: "unread", label: "Unread", count: notifications.data?.unread },
          ]}
          active={tab}
          onChange={(key) => {
            setTab(key as "all" | "unread");
            setPage(1);
          }}
        />
        <Select
          value={category ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            setCategory(value === "" ? null : (value as NotificationCategory));
            setPage(1);
          }}
          aria-label="Filter by category"
          className="max-w-48"
        >
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === "" ? "All categories" : option.charAt(0) + option.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-2 px-3 py-3 sm:px-4">
          <QueryBoundary query={notifications}>
            {(notifications.data?.rows.length ?? 0) === 0 ? (
              <EmptyState
                icon={<Bell className="size-6" aria-hidden />}
                title={tab === "unread" ? "Nothing unread" : "No notifications yet"}
                body={
                  tab === "unread"
                    ? "You have read everything — nice."
                    : "When syncs finish, security events fire or the AI engine has news, it lands here instantly."
                }
              />
            ) : (
              notifications.data?.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    if (canUpdate && row.readAt === null) markRead.mutate(row.id);
                    if (row.actionUrl !== null) navigate(row.actionUrl);
                  }}
                  className="flex w-full items-start gap-3 rounded-lg border border-subtle bg-surface-raised/40 px-4 py-3.5 text-left transition-colors hover:border-strong focus-visible:outline-2 focus-visible:outline-primary"
                >
                  <span
                    className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${row.readAt === null ? "bg-primary" : "bg-transparent"}`}
                    aria-label={row.readAt === null ? "Unread" : "Read"}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{row.title}</span>
                      <span className="text-[11px] text-faint">{formatRelativeTime(row.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{row.body}</span>
                    <span className="mt-2 inline-flex items-center gap-2">
                      <Badge tone={CATEGORY_TONE[row.category] ?? "neutral"}>{row.category}</Badge>
                      {row.actionUrl !== null && <span className="text-[11px] font-medium text-primary">Open →</span>}
                    </span>
                  </span>
                </button>
              ))
            )}
          </QueryBoundary>
        </CardBody>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-subtle px-4 py-3">
            <p className="text-xs text-muted">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Prev
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
