import { useState, type ReactNode } from "react";
import { LifeBuoy, Plus, Send } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Drawer,
  EmptyState,
  Input,
  Modal,
  Select,
  SkeletonText,
  Textarea,
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { useAuth } from "../../lib/auth-context";
import { formatDateTime } from "../../lib/format";
import { QueryBoundary } from "../../components/QueryBoundary";
import {
  useCloseTicketMutation,
  useCreateTicketMutation,
  useReplyTicketMutation,
  useSupportTicketQuery,
  useSupportTicketsQuery,
} from "../../lib/support-queries";
import type {
  SupportTicketCategoryDto,
  SupportTicketPriorityDto,
  SupportTicketRowDto,
} from "../../lib/api-types";

/**
 * Merchant ticket workspace (M6): real two-way conversations with the
 * platform operators. Statuses are honest state, not decoration — replies
 * reopen tickets the operator resolved, and close is merchant-final.
 */

const STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  OPEN: "info",
  AWAITING_OPERATOR: "warning",
  AWAITING_MERCHANT: "info",
  RESOLVED: "success",
  CLOSED: "neutral",
};

const PRIORITY_OPTIONS: ReadonlyArray<{ value: SupportTicketPriorityDto; label: string }> = [
  { value: "LOW", label: "Low — whenever" },
  { value: "NORMAL", label: "Normal" },
  { value: "HIGH", label: "High — hurts my business" },
  { value: "URGENT", label: "Urgent — storefront is broken" },
];

const CATEGORY_OPTIONS: ReadonlyArray<{ value: SupportTicketCategoryDto; label: string }> = [
  { value: "BUG", label: "Something is broken" },
  { value: "BILLING", label: "Billing question" },
  { value: "DATA", label: "Data looks wrong" },
  { value: "FEATURE", label: "Feature request" },
  { value: "OTHER", label: "Something else" },
];

function NewTicketDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const toast = useToast();
  const create = useCreateTicketMutation();
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<SupportTicketCategoryDto>("BUG");
  const [priority, setPriority] = useState<SupportTicketPriorityDto>("NORMAL");
  const [body, setBody] = useState("");

  const submit = (): void => {
    create.mutate(
      { subject: subject.trim(), category, priority, body: body.trim() },
      {
        onSuccess: () => {
          toast.success("Ticket opened", "The team sees it in the operator console — replies land here and by email.");
          onClose();
          setSubject("");
          setBody("");
        },
        onError: (error) => toast.error("Ticket could not be opened", error.message),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a ticket"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={create.isPending} disabled={subject.trim() === "" || body.trim() === ""}>
            Send to the team
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Subject</span>
          <Input value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} autoFocus aria-label="Ticket subject" placeholder="Export stopped at 200 rows" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Category</span>
            <Select value={category} onChange={(event) => setCategory(event.target.value as SupportTicketCategoryDto)} aria-label="Ticket category">
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Priority</span>
            <Select value={priority} onChange={(event) => setPriority(event.target.value as SupportTicketPriorityDto)} aria-label="Ticket priority">
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">What is happening?</span>
          <Textarea
            value={body}
            rows={5}
            maxLength={10_000}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Ticket body"
            placeholder="What you clicked, what you expected, what happened instead. An error id from the error screen helps enormously."
          />
        </label>
      </div>
    </Modal>
  );
}

function TicketThreadDrawer({ ticketId, onClose }: { readonly ticketId: string; readonly onClose: () => void }): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("support:manage");
  const toast = useToast();
  const thread = useSupportTicketQuery(ticketId);
  const reply = useReplyTicketMutation();
  const close = useCloseTicketMutation();
  const [draft, setDraft] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);

  const send = (): void => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    reply.mutate(
      { ticketId, body: trimmed },
      {
        onSuccess: () => setDraft(""),
        onError: (error) => toast.error("Reply could not be sent", error.message),
      },
    );
  };

  return (
    <Drawer open onClose={onClose} title="Conversation" width="lg">
      <QueryBoundary query={thread} loading={<SkeletonText lines={6} />}>
        {thread.data !== undefined && (
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[thread.data.ticket.status] ?? "neutral"}>{thread.data.ticket.status.replaceAll("_", " ")}</Badge>
              <span className="text-sm font-medium text-foreground">{thread.data.ticket.subject}</span>
            </div>
            <ul className="flex flex-col gap-2.5" aria-label="Messages">
              {thread.data.messages.map((message) => {
                const mine = message.authorKind === "MERCHANT";
                return (
                  <li
                    key={message.id}
                    className={[
                      "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed",
                      mine ? "ml-auto bg-primary-soft text-foreground" : "bg-surface-raised text-foreground",
                    ].join(" ")}
                  >
                    <p className="whitespace-pre-wrap">{message.body}</p>
                    <p className="mt-1 text-[10px] text-faint">
                      {mine ? "You" : (message.authorOperator ?? "Profit Tool team")} · {formatDateTime(message.createdAt)}
                    </p>
                  </li>
                );
              })}
            </ul>
            {thread.data.ticket.status !== "CLOSED" ? (
              canManage ? (
                <div className="mt-auto flex flex-col gap-2 border-t border-subtle pt-3">
                  <Textarea
                    value={draft}
                    rows={3}
                    maxLength={10_000}
                    onChange={(event) => setDraft(event.target.value)}
                    aria-label="Reply"
                    placeholder={thread.data.ticket.status === "RESOLVED" ? "Replying reopens the ticket…" : "Write a reply…"}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setCloseOpen(true)}>
                      Close ticket
                    </Button>
                    <Button size="sm" onClick={send} loading={reply.isPending} disabled={draft.trim() === ""} iconLeft={<Send className="size-3.5" aria-hidden />}>
                      Send reply
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-faint">Replies need the support:manage permission — ask a store manager.</p>
              )
            ) : (
              <p className="rounded-md bg-surface-raised px-3 py-2 text-xs text-muted">
                Closed {thread.data.ticket.closedAt !== null ? formatDateTime(thread.data.ticket.closedAt) : ""} — open a new ticket if this comes back.
              </p>
            )}
            <ConfirmDialog
              open={closeOpen}
              onClose={() => setCloseOpen(false)}
              onConfirm={() => {
                setCloseOpen(false);
                close.mutate(ticketId, {
                  onSuccess: () => toast.success("Ticket closed"),
                  onError: (error) => toast.error("Ticket could not be closed", error.message),
                });
              }}
              title="Close this ticket?"
              body="Closing is final for this conversation — a closed ticket cannot be reopened. You can always open a new one."
              confirmLabel="Close ticket"
              loading={close.isPending}
            />
          </div>
        )}
      </QueryBoundary>
    </Drawer>
  );
}

/** Tickets workspace — mounts only when the user holds support:read. */
export function TicketsWorkspace(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("support:manage");
  const [page, setPage] = useState(1);
  const tickets = useSupportTicketsQuery(page);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const columns: readonly ColumnDef<SupportTicketRowDto>[] = [
    {
      key: "subject",
      header: "Conversation",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{row.subject}</p>
          <p className="truncate text-[11px] text-faint">
            {row.category} · {row.messageCount} message{row.messageCount === 1 ? "" : "s"}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status.replaceAll("_", " ")}</Badge>,
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
    <Card>
      <CardHeader
        title="Your conversations with the team"
        subtitle="Real tickets, answered by the people running Profit Tool — replies arrive here and by email."
        actions={
          canManage ? (
            <Button size="sm" iconLeft={<Plus className="size-3.5" aria-hidden />} onClick={() => setCreateOpen(true)}>
              New ticket
            </Button>
          ) : undefined
        }
      />
      <CardBody className="px-0 pb-0 pt-1">
        <DataTable
          columns={columns}
          rows={tickets.data?.rows ?? []}
          rowKey={(row) => row.id}
          loading={tickets.isPending}
          onRowClick={(row) => setOpenTicketId(row.id)}
          emptyState={
            <EmptyState
              icon={<LifeBuoy className="size-6" aria-hidden />}
              title="No tickets yet"
              body="When email is not enough, open a ticket — the whole thread stays attached to your store."
            />
          }
          pagination={
            tickets.data !== undefined
              ? { page, pageSize: 20, totalItems: tickets.data.total, onPageChange: setPage }
              : undefined
          }
        />
      </CardBody>
      {openTicketId !== null && <TicketThreadDrawer ticketId={openTicketId} onClose={() => setOpenTicketId(null)} />}
      <NewTicketDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </Card>
  );
}
