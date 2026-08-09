import { useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  Select,
  SkeletonText,
  Textarea,
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { AdminEmpty, AdminView } from "./AdminShared";
import { formatDateTime } from "../lib/format";
import { ApiError } from "../lib/api-client";
import {
  useAdminTicketQuery,
  useAdminTicketReplyMutation,
  useAdminTicketsQuery,
  useAdminTicketTransitionMutation,
} from "../lib/admin-queries";
import type { AdminTicketRowDto } from "../lib/api-types";
import type { AdminSession } from "./admin-session-store";

/**
 * Operator support inbox (M6): cross-tenant by deliberate design — the
 * merchant's shop domain is shown on every row so no reply ever lands in
 * the wrong store. Replies and transitions require the step-up session;
 * the server stamps the operator id onto every action.
 */

const STATUS_TONE: Readonly<Record<string, "success" | "danger" | "info" | "warning" | "neutral">> = {
  OPEN: "info",
  AWAITING_OPERATOR: "warning",
  AWAITING_MERCHANT: "info",
  RESOLVED: "success",
  CLOSED: "neutral",
};

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "OPEN", label: "Open" },
  { value: "AWAITING_OPERATOR", label: "Awaiting operator" },
  { value: "AWAITING_MERCHANT", label: "Awaiting merchant" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "CLOSED", label: "Closed" },
];

function TicketThread({
  adminKey,
  session,
  ticketId,
  onClose,
}: {
  readonly adminKey: string;
  readonly session: AdminSession | null;
  readonly ticketId: string;
  readonly onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const thread = useAdminTicketQuery({ adminKey }, ticketId);
  const reply = useAdminTicketReplyMutation(adminKey, session);
  const transition = useAdminTicketTransitionMutation(adminKey, session);
  const [draft, setDraft] = useState("");

  const writeBlocked = session === null;
  const guardWrite = (title: string): void => {
    toast.error(title, "Unlock write actions first — every operator write needs the step-up session (it is audit-stamped).");
  };

  const send = (): void => {
    if (session === null) {
      guardWrite("Reply not sent");
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === "") return;
    reply.mutate(
      { ticketId, body: trimmed },
      {
        onSuccess: () => {
          setDraft("");
          toast.success("Reply sent", "The merchant sees it in-app and by email.");
        },
        onError: (error: ApiError) => {
          toast.error("Reply could not be sent", error.message);
        },
      },
    );
  };

  const move = (verb: "resolve" | "close"): void => {
    if (session === null) {
      guardWrite(verb === "resolve" ? "Could not resolve" : "Could not close");
      return;
    }
    transition.mutate(
      { ticketId, verb },
      {
        onSuccess: () => toast.success(verb === "resolve" ? "Ticket resolved" : "Ticket closed"),
        onError: (error: ApiError) => {
          toast.error("Transition failed", error.message);
        },
      },
    );
  };

  return (
    <Drawer open onClose={onClose} title="Ticket thread" width="lg">
      {thread.isPending ? (
        <SkeletonText lines={6} />
      ) : thread.isError ? (
        <p role="alert" className="text-sm text-danger">{thread.error.message}</p>
      ) : thread.data !== undefined ? (
        <div className="flex h-full flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[thread.data.ticket.status] ?? "neutral"}>
              {thread.data.ticket.status.replaceAll("_", " ")}
            </Badge>
            <span className="text-sm font-medium text-foreground">{thread.data.ticket.subject}</span>
            <span className="text-xs text-faint">
              {thread.data.ticket.shopDomain} · {thread.data.ticket.openerEmail ?? "no opener on file"}
            </span>
          </div>
          <ul className="flex flex-col gap-2.5" aria-label="Thread messages">
            {thread.data.messages.map((message) => {
              const operator = message.authorKind === "OPERATOR";
              return (
                <li
                  key={message.id}
                  className={[
                    "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                    operator ? "ml-auto bg-primary-soft text-foreground" : "bg-surface-raised text-foreground",
                  ].join(" ")}
                >
                  <p className="whitespace-pre-wrap">{message.body}</p>
                  <p className="mt-1 text-[10px] text-faint">
                    {operator ? `Operator ${message.authorOperator ?? ""}` : (message.authorEmail ?? "merchant")} ·{" "}
                    {formatDateTime(message.createdAt)}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="mt-auto flex flex-col gap-2 border-t border-subtle pt-3">
            <Textarea
              value={draft}
              rows={3}
              maxLength={10_000}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Operator reply"
              placeholder={writeBlocked ? "Unlock write actions to reply…" : "Reply to the merchant…"}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" disabled={writeBlocked} onClick={() => move("resolve")}>
                  Resolve
                </Button>
                <Button size="sm" variant="ghost" disabled={writeBlocked} onClick={() => move("close")}>
                  Close
                </Button>
              </div>
              <Button size="sm" onClick={send} loading={reply.isPending} disabled={draft.trim() === ""} iconLeft={<Send className="size-3.5" aria-hidden />}>
                Send reply
              </Button>
            </div>
            {writeBlocked && <p className="text-[11px] text-faint">Reads are open; writes need the step-up session.</p>}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

export function AdminTicketsView({
  adminKey,
  session,
}: {
  readonly adminKey: string;
  readonly session: AdminSession | null;
}): ReactNode {
  const [page, setPage] = useState(1);
  const [attentionOnly, setAttentionOnly] = useState(true);
  const [status, setStatus] = useState("");
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const query = useAdminTicketsQuery({ adminKey }, page, attentionOnly, status);

  const columns: readonly ColumnDef<AdminTicketRowDto>[] = [
    {
      key: "subject",
      header: "Ticket",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{row.subject}</p>
          <p className="truncate text-[11px] text-faint">
            {row.shopDomain} · {row.category} · {row.priority}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status.replaceAll("_", " ")}</Badge>
          {row.operatorAttention && <span className="size-1.5 rounded-full bg-warning" title="Needs operator attention" aria-label="Needs operator attention" />}
        </div>
      ),
    },
    {
      key: "opener",
      header: "Opened by",
      cell: (row) => <span className="text-xs text-muted">{row.openerEmail ?? "—"}</span>,
    },
    {
      key: "when",
      header: "Last activity",
      align: "right",
      cell: (row) => (
        <span className="text-xs text-muted">
          {row.lastMessageAt !== null ? formatDateTime(row.lastMessageAt) : formatDateTime(row.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <AdminView
      title="Support inbox"
      subtitle="Merchant tickets across every store. Replies and transitions are operator-stamped and audit-logged."
      query={query}
    >
      <DataTable
        columns={columns}
        rows={query.data?.rows ?? []}
        rowKey={(row) => row.id}
        onRowClick={(row) => setOpenTicketId(row.id)}
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                checked={attentionOnly}
                onChange={(event) => {
                  setAttentionOnly(event.target.checked);
                  setPage(1);
                }}
                aria-label="Needs attention only"
              />
              Needs attention only
            </label>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by status"
              className="max-w-44"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        }
        emptyState={
          <AdminEmpty
            title={attentionOnly || status !== "" ? "Nothing matches these filters" : "Inbox zero"}
            body={
              attentionOnly || status !== ""
                ? "Loosen the filters to see the full queue."
                : "Merchant tickets land here the moment they are opened."
            }
          />
        }
        pagination={
          query.data !== undefined
            ? { page, pageSize: 25, totalItems: query.data.total, onPageChange: setPage }
            : undefined
        }
      />
      {openTicketId !== null && (
        <TicketThread adminKey={adminKey} session={session} ticketId={openTicketId} onClose={() => setOpenTicketId(null)} />
      )}
    </AdminView>
  );
}
