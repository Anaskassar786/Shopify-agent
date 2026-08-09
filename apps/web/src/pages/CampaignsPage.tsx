import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, Megaphone, Plus, Trash2 } from "lucide-react";
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
  Tabs,
  Textarea,
  useToast,
  type ColumnDef,
} from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { formatDateTime } from "../lib/format";
import {
  useCampaignsQuery,
  useCampaignStatsQuery,
  useCampaignTemplatesQuery,
  useCancelCampaignMutation,
  useCreateCampaignMutation,
  useCreateTemplateMutation,
  useDeclareWinnerMutation,
  useScheduleCampaignMutation,
  useDeleteTemplateMutation,
  useSuppressionsQuery,
  useUpdateTemplateMutation,
  type VariantInput,
} from "../lib/campaign-queries";
import type {
  CampaignAudienceDto,
  CampaignRowDto,
  CampaignStatsResponse,
  CampaignTemplateRowDto,
  CampaignVariantDto,
  MessageChannelDto,
  SuppressionRowDto,
} from "../lib/api-types";

const STATUS_TONE: Record<string, "success" | "danger" | "info" | "warning" | "neutral"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  SENDING: "warning",
  SENT: "success",
  CANCELLED: "neutral",
  FAILED: "danger",
};

const AUDIENCE_LABEL: Record<CampaignAudienceDto, string> = {
  ALL_CUSTOMERS: "All customers",
  MARKETING_OPT_IN: "Marketing opt-in only",
  REPEAT_CUSTOMERS: "Repeat customers (2+ orders)",
};

function percent(rate: number | null): string {
  return rate === null ? "—" : `${String(Math.round(rate * 1000) / 10)}%`;
}

/* ── campaign detail drawer ──────────────────────────────────────────────── */

function CampaignDetailDrawer({
  campaign,
  canManage,
  onClose,
}: {
  readonly campaign: CampaignRowDto;
  readonly canManage: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const toast = useToast();
  const stats = useCampaignStatsQuery(campaign.id);
  const schedule = useScheduleCampaignMutation();
  const cancel = useCancelCampaignMutation();
  const winner = useDeclareWinnerMutation();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const errorToast = (title: string) => (error: { message: string }): void => {
      toast.error(title, error.message);
    };
  const hasVariantB = campaign.variantB !== null;
  const lifecycleBusy = schedule.isPending || cancel.isPending || winner.isPending;

  return (
    <Drawer open onClose={onClose} title={
      <span className="flex items-center gap-2">
        <span className="truncate">{campaign.name}</span>
        <Badge tone={STATUS_TONE[campaign.status] ?? "neutral"}>{campaign.status}</Badge>
      </span>
    } width="lg">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Fact label="Channel" value={campaign.channel} />
          <Fact label="Audience" value={AUDIENCE_LABEL[campaign.audience]} />
          <Fact
            label="Scheduled"
            value={
              campaign.scheduledAt !== null
                ? formatDateTime(campaign.scheduledAt)
                : campaign.status === "SCHEDULED"
                  ? "Next dispatch tick"
                  : "—"
            }
          />
          <Fact label="Split B" value={hasVariantB ? `${String(campaign.splitBPercent)}%` : "no A/B test"} />
        </div>
        {campaign.lastError !== null && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">{campaign.lastError}</p>
        )}
        {campaign.winnerVariant !== null && (
          <p className="rounded-md bg-success-soft px-3 py-2 text-xs text-success">
            Variant {campaign.winnerVariant} was declared the winner — remaining recipients received it.
          </p>
        )}

        <QueryBoundary query={stats} loading={<SkeletonText lines={5} />}>
          {stats.data !== undefined && <CampaignStatsView stats={stats.data} />}
        </QueryBoundary>

        {canManage && (campaign.status === "DRAFT" || campaign.status === "SCHEDULED") && (
          <div className="flex flex-col gap-3 rounded-lg border border-subtle p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Delivery</p>
            {campaign.status === "DRAFT" && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Send at (optional)</span>
                  <Input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(event) => setScheduleAt(event.target.value)}
                    aria-label="Schedule date"
                  />
                </label>
                <Button
                  size="sm"
                  loading={schedule.isPending}
                  onClick={() =>
                    schedule.mutate(
                      {
                        campaignId: campaign.id,
                        scheduledAt: scheduleAt === "" ? null : new Date(scheduleAt).toISOString(),
                      },
                      {
                        onSuccess: () => toast.success("Campaign scheduled", "Recipients materialize at dispatch — suppressed destinations are skipped honestly."),
                        onError: errorToast("Could not schedule"),
                      },
                    )
                  }
                >
                  {scheduleAt === "" ? "Send on next tick" : "Schedule"}
                </Button>
              </div>
            )}
            {campaign.status === "SCHEDULED" && (
              <p className="text-xs text-muted">Queued for dispatch. The worker takes it from here — tracked delivery, batched and throttled.</p>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)} disabled={lifecycleBusy} iconLeft={<Ban className="size-3.5" aria-hidden />}>
              Cancel campaign
            </Button>
          </div>
        )}

        {canManage && hasVariantB && campaign.winnerVariant === null && (campaign.status === "SENDING" || campaign.status === "SENT") && (
          <div className="flex flex-col gap-2 rounded-lg border border-subtle p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Declare a winner</p>
            <p className="text-xs text-muted">Pending recipients switch to the winning variant immediately.</p>
            <div className="flex gap-2">
              {(["A", "B"] as const).map((variant) => (
                <Button
                  key={variant}
                  size="sm"
                  variant="secondary"
                  disabled={lifecycleBusy}
                  onClick={() =>
                    winner.mutate(
                      { campaignId: campaign.id, variant: variant as CampaignVariantDto },
                      { onSuccess: () => toast.success(`Variant ${variant} wins`), onError: errorToast("Could not declare winner") },
                    )
                  }
                >
                  Variant {variant} wins
                </Button>
              ))}
            </div>
          </div>
        )}

        <ConfirmDialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onConfirm={() => {
            setCancelOpen(false);
            cancel.mutate(campaign.id, {
              onSuccess: () => toast.success("Campaign cancelled", "Nothing more will send."),
              onError: errorToast("Could not cancel"),
            });
          }}
          title="Cancel this campaign?"
          body="Cancel stops every not-yet-sent recipient. Deliveries already made are not retracted — the ledger keeps them."
          confirmLabel="Cancel campaign"
          danger
          loading={cancel.isPending}
        />
      </div>
    </Drawer>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className="rounded-md bg-surface-raised px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-0.5 truncate text-xs font-medium text-foreground">{value}</p>
    </div>
  );
}

function CampaignStatsView({ stats }: { readonly stats: CampaignStatsResponse }): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["Sent", stats.recipients.sent, "text-foreground"],
            ["Pending", stats.recipients.pending, "text-foreground"],
            ["Skipped", stats.recipients.skipped, "text-warning"],
            ["Failed", stats.recipients.failed, "text-danger"],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded-md bg-surface-raised px-2 py-2.5">
            <p className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</p>
            <p className="text-[10px] text-muted">{label}</p>
          </div>
        ))}
      </div>

      {stats.variants.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-subtle">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-subtle bg-surface-raised text-[10px] uppercase tracking-wide text-faint">
                <th className="px-3 py-2">Variant</th>
                <th className="px-3 py-2 text-right">Sent</th>
                <th className="px-3 py-2 text-right">Opens</th>
                <th className="px-3 py-2 text-right">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {stats.variants.map((variant) => (
                <tr key={variant.variant} className="border-b border-subtle last:border-0">
                  <td className="px-3 py-2 font-semibold text-foreground">{variant.variant}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{variant.sent}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">
                    {variant.uniqueOpens} ({percent(variant.openRate)})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">
                    {variant.uniqueClicks} ({percent(variant.clickRate)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted">
        {stats.unsubscribes} unsubscribe{stats.unsubscribes === 1 ? "" : "s"} recorded — those destinations are suppressed from every future send.
      </p>

      {stats.recentEvents.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Recent events</p>
          <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {stats.recentEvents.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-muted">
                  <Badge tone={event.kind === "OPENED" ? "info" : event.kind === "CLICKED" ? "success" : "neutral"}>{event.kind}</Badge>{" "}
                  {event.url ?? ""}
                </span>
                <span className="shrink-0 text-[11px] text-faint">{formatDateTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── variant editor (shared by create wizard A/B halves) ─────────────────── */

interface VariantDraft {
  templateId: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

const EMPTY_VARIANT: VariantDraft = { templateId: "", subject: "", bodyText: "", bodyHtml: "" };

function VariantFields({
  label,
  channel,
  draft,
  templates,
  onChange,
}: {
  readonly label: string;
  readonly channel: MessageChannelDto;
  readonly draft: VariantDraft;
  readonly templates: readonly CampaignTemplateRowDto[];
  readonly onChange: (next: VariantDraft) => void;
}): ReactNode {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-subtle p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-faint">{label}</legend>
      {templates.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Start from template (optional)</span>
          <Select
            value={draft.templateId}
            onChange={(event) => {
              const template = templates.find((candidate) => candidate.id === event.target.value);
              onChange(
                template === undefined
                  ? { ...draft, templateId: "" }
                  : {
                      templateId: template.id,
                      subject: template.subject ?? "",
                      bodyText: template.bodyText,
                      bodyHtml: template.bodyHtml ?? "",
                    },
              );
            }}
            aria-label={`${label} template`}
          >
            <option value="">Write from scratch</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} (v{template.version})
              </option>
            ))}
          </Select>
        </label>
      )}
      {channel === "EMAIL" && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Subject</span>
          <Input
            value={draft.subject}
            maxLength={200}
            onChange={(event) => onChange({ ...draft, subject: event.target.value })}
            aria-label={`${label} subject`}
          />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Body</span>
        <Textarea
          value={draft.bodyText}
          rows={4}
          maxLength={5_000}
          onChange={(event) => onChange({ ...draft, bodyText: event.target.value })}
          aria-label={`${label} body`}
          placeholder={channel === "EMAIL" ? "Hi {{customer.firstName}}, …" : "{{store.name}}: your code inside — reply STOP to opt out"}
        />
      </label>
    </fieldset>
  );
}

/* ── create wizard ───────────────────────────────────────────────────────── */

function NewCampaignDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const toast = useToast();
  const create = useCreateCampaignMutation();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<MessageChannelDto>("EMAIL");
  const [audience, setAudience] = useState<CampaignAudienceDto>("ALL_CUSTOMERS");
  const [variantA, setVariantA] = useState<VariantDraft>(EMPTY_VARIANT);
  const [useVariantB, setUseVariantB] = useState(false);
  const [variantB, setVariantB] = useState<VariantDraft>(EMPTY_VARIANT);
  const [splitB, setSplitB] = useState(50);
  const templates = useCampaignTemplatesQuery(channel);

  const valid =
    name.trim() !== "" &&
    variantA.bodyText.trim() !== "" &&
    (channel === "SMS" || variantA.subject.trim() !== "") &&
    (!useVariantB || (variantB.bodyText.trim() !== "" && (channel === "SMS" || variantB.subject.trim() !== "")));

  const submit = (): void => {
    const toVariant = (draft: VariantDraft): VariantInput => ({
      ...(draft.templateId !== "" ? { templateId: draft.templateId } : {}),
      ...(channel === "EMAIL" ? { subject: draft.subject.trim() } : {}),
      bodyText: draft.bodyText,
      ...(channel === "EMAIL" && draft.bodyHtml.trim() !== "" ? { bodyHtml: draft.bodyHtml } : {}),
    });
    create.mutate(
      {
        name: name.trim(),
        channel,
        audience,
        variantA: toVariant(variantA),
        ...(useVariantB ? { variantB: toVariant(variantB), splitBPercent: splitB } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Campaign drafted", "Review it, then schedule from the detail panel.");
          onClose();
          setName("");
          setVariantA(EMPTY_VARIANT);
          setVariantB(EMPTY_VARIANT);
          setUseVariantB(false);
        },
        onError: (error) => { toast.error("Campaign could not be created", error.message); },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New campaign"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={create.isPending} disabled={!valid}>
            Create draft
          </Button>
        </>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <Input value={name} maxLength={140} onChange={(event) => setName(event.target.value)} autoFocus aria-label="Campaign name" placeholder="Spring win-back" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Channel</span>
            <Select value={channel} onChange={(event) => setChannel(event.target.value as MessageChannelDto)} aria-label="Channel">
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS (Twilio)</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Audience</span>
            <Select value={audience} onChange={(event) => setAudience(event.target.value as CampaignAudienceDto)} aria-label="Audience">
              {(Object.keys(AUDIENCE_LABEL) as readonly CampaignAudienceDto[]).map((value) => (
                <option key={value} value={value}>
                  {AUDIENCE_LABEL[value]}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <VariantFields label="Variant A" channel={channel} draft={variantA} templates={templates.data ?? []} onChange={setVariantA} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-[var(--color-primary)]"
            checked={useVariantB}
            onChange={(event) => setUseVariantB(event.target.checked)}
            aria-label="Test a variant B"
          />
          Test a variant B (A/B split)
        </label>
        {useVariantB && (
          <>
            <VariantFields label="Variant B" channel={channel} draft={variantB} templates={templates.data ?? []} onChange={setVariantB} />
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Share receiving variant B: {splitB}%</span>
              <input
                type="range"
                min={1}
                max={99}
                value={splitB}
                onChange={(event) => setSplitB(Number(event.target.value))}
                aria-label="Variant B share"
                className="w-full accent-[var(--color-primary)]"
              />
            </label>
          </>
        )}
        <p className="text-[11px] leading-relaxed text-faint">
          Nothing sends on create. Scheduling materializes recipients server-side; unsubscribed destinations are skipped and counted, never mailed.
        </p>
      </div>
    </Modal>
  );
}

/* ── templates tab ───────────────────────────────────────────────────────── */

function TemplatesPanel({ canManage }: { readonly canManage: boolean }): ReactNode {
  const toast = useToast();
  const [channelFilter, setChannelFilter] = useState<MessageChannelDto | "">("");
  const templates = useCampaignTemplatesQuery(channelFilter);
  const createTemplate = useCreateTemplateMutation();
  const updateTemplate = useUpdateTemplateMutation();
  const deleteTemplate = useDeleteTemplateMutation();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CampaignTemplateRowDto | null>(null);
  const [deleting, setDeleting] = useState<CampaignTemplateRowDto | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftChannel, setDraftChannel] = useState<MessageChannelDto>("EMAIL");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");

  useEffect(() => {
    if (editorOpen && editing !== null) {
      setDraftName(editing.name);
      setDraftChannel(editing.channel);
      setDraftSubject(editing.subject ?? "");
      setDraftBody(editing.bodyText);
    }
    if (editorOpen && editing === null) {
      setDraftName("");
      setDraftChannel("EMAIL");
      setDraftSubject("");
      setDraftBody("");
    }
  }, [editorOpen, editing]);

  const columns: readonly ColumnDef<CampaignTemplateRowDto>[] = [
    {
      key: "name",
      header: "Template",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
          <p className="truncate text-[11px] text-faint">{row.subject ?? row.bodyText.slice(0, 60)}</p>
        </div>
      ),
    },
    { key: "channel", header: "Channel", cell: (row) => <Badge tone={row.channel === "EMAIL" ? "info" : "warning"}>{row.channel}</Badge> },
    { key: "version", header: "Version", align: "right", cell: (row) => <span className="tabular-nums text-xs text-muted">v{row.version}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (row) =>
        canManage ? (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                setEditing(row);
                setEditorOpen(true);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                setDeleting(row);
              }}
              aria-label={`Delete ${row.name}`}
            >
              <Trash2 className="size-3.5 text-danger" aria-hidden />
            </Button>
          </div>
        ) : null,
    },
  ];

  const saveTemplate = (): void => {
    const body = {
      name: draftName.trim(),
      channel: draftChannel,
      ...(draftChannel === "EMAIL" ? { subject: draftSubject.trim() } : {}),
      bodyText: draftBody,
    };
    const onError = (error: { message: string }): void => {
      toast.error("Template could not be saved", error.message);
    };
    if (editing !== null) {
      updateTemplate.mutate({ templateId: editing.id, ...body }, {
        onSuccess: () => {
          toast.success("Template updated", "Version bumped — campaigns pick it up at dispatch.");
          setEditorOpen(false);
        },
        onError,
      });
    } else {
      createTemplate.mutate(body, {
        onSuccess: () => {
          toast.success("Template created");
          setEditorOpen(false);
        },
        onError,
      });
    }
  };

  return (
    <>
      <DataTable
        columns={columns}
        rows={templates.data ?? []}
        rowKey={(row) => row.id}
        loading={templates.isPending}
        toolbar={
          <div className="flex w-full items-center justify-between gap-2">
            <Select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value as MessageChannelDto | "")} aria-label="Filter by channel" className="max-w-40">
              <option value="">All channels</option>
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </Select>
            {canManage && (
              <Button
                size="sm"
                iconLeft={<Plus className="size-3.5" aria-hidden />}
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                New template
              </Button>
            )}
          </div>
        }
        emptyState={
          <EmptyState
            icon={<Megaphone className="size-6" aria-hidden />}
            title="No templates yet"
            body="Reusable message bodies with personalization variables — campaigns can start from them."
          />
        }
      />

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing !== null ? `Edit “${editing.name}”` : "New template"}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={saveTemplate}
              loading={createTemplate.isPending || updateTemplate.isPending}
              disabled={draftName.trim() === "" || draftBody.trim() === "" || (draftChannel === "EMAIL" && draftSubject.trim() === "")}
            >
              {editing !== null ? "Save new version" : "Create template"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Name</span>
            <Input value={draftName} maxLength={140} onChange={(event) => setDraftName(event.target.value)} aria-label="Template name" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Channel</span>
            <Select value={draftChannel} onChange={(event) => setDraftChannel(event.target.value as MessageChannelDto)} aria-label="Template channel" disabled={editing !== null}>
              <option value="EMAIL">Email (subject required)</option>
              <option value="SMS">SMS (no subject)</option>
            </Select>
          </label>
          {draftChannel === "EMAIL" && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Subject</span>
              <Input value={draftSubject} maxLength={200} onChange={(event) => setDraftSubject(event.target.value)} aria-label="Template subject" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Body</span>
            <Textarea value={draftBody} rows={6} maxLength={5_000} onChange={(event) => setDraftBody(event.target.value)} aria-label="Template body" placeholder="Hi {{customer.firstName}}, …" />
          </label>
          <p className="text-[11px] leading-relaxed text-faint">
            Allowed variables: store.name, store.domain, customer.firstName/lastName/fullName/email/ordersCount/totalSpent, campaign.name, workflow.name, unsubscribeUrl. Unknown variables fail loudly, never silently.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting === null) return;
          deleteTemplate.mutate(deleting.id, {
            onSuccess: () => toast.success("Template deleted"),
            onError: (error) => { toast.error("Template could not be deleted", error.message); },
          });
          setDeleting(null);
        }}
        title={`Delete “${deleting?.name ?? ""}”?`}
        body="Campaigns that already snapshot this template are unaffected. Drafts that referenced it fall back to their inline copy."
        confirmLabel="Delete template"
        danger
        loading={deleteTemplate.isPending}
      />
    </>
  );
}

/* ── suppressions tab ────────────────────────────────────────────────────── */

function SuppressionsPanel(): ReactNode {
  const [channel, setChannel] = useState<MessageChannelDto>("EMAIL");
  const [page, setPage] = useState(1);
  const suppressions = useSuppressionsQuery(channel, page);

  const columns: readonly ColumnDef<SuppressionRowDto>[] = [
    { key: "destination", header: "Destination", cell: (row) => <span className="font-mono text-xs text-foreground">{row.destination}</span> },
    { key: "reason", header: "Reason", cell: (row) => <Badge tone={row.reason === "UNSUBSCRIBE" ? "warning" : "danger"}>{row.reason.replaceAll("_", " ")}</Badge> },
    { key: "when", header: "Recorded", align: "right", cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.createdAt)}</span> },
  ];

  return (
    <div>
      <Tabs
        items={[
          { key: "EMAIL", label: "Email" },
          { key: "SMS", label: "SMS" },
        ]}
        active={channel}
        onChange={(key) => {
          setChannel(key as MessageChannelDto);
          setPage(1);
        }}
      />
      <div className="mt-3">
        <DataTable
          columns={columns}
          rows={suppressions.data?.rows ?? []}
          rowKey={(row) => row.id}
          loading={suppressions.isPending}
          emptyState={
            <EmptyState
              icon={<Ban className="size-6" aria-hidden />}
              title="No suppressions"
              body="Destinations land here when they unsubscribe or a send hard-fails — and are skipped by every future campaign."
            />
          }
          pagination={
            suppressions.data !== undefined
              ? { page, pageSize: 25, totalItems: suppressions.data.total, onPageChange: setPage }
              : undefined
          }
        />
      </div>
    </div>
  );
}

/* ── page root ───────────────────────────────────────────────────────────── */

export function CampaignsPage(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("campaigns:manage");
  const [tab, setTab] = useState<"campaigns" | "templates" | "suppressions">("campaigns");
  const campaigns = useCampaignsQuery();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const detail = useMemo(
    () => (campaigns.data ?? []).find((campaign) => campaign.id === detailId) ?? null,
    [campaigns.data, detailId],
  );

  const columns: readonly ColumnDef<CampaignRowDto>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Campaign",
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
            <p className="truncate text-[11px] text-faint">{AUDIENCE_LABEL[row.audience]}</p>
          </div>
        ),
      },
      { key: "channel", header: "Channel", cell: (row) => <Badge tone={row.channel === "EMAIL" ? "info" : "warning"}>{row.channel}</Badge> },
      { key: "status", header: "Status", cell: (row) => <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge> },
      {
        key: "recipients",
        header: "Delivery",
        align: "right",
        cell: (row) => (
          <span className="tabular-nums text-xs text-muted">
            {row.recipientCount} recipients · {row.sentCount} sent{row.failedCount > 0 ? ` · ${row.failedCount} failed` : ""}
          </span>
        ),
      },
      {
        key: "when",
        header: "Updated",
        align: "right",
        cell: (row) => <span className="text-xs text-muted">{formatDateTime(row.updatedAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Campaigns"
        subtitle="Email and SMS sends with A/B variants, tracked engagement and honest opt-outs."
        actions={
          canManage && tab === "campaigns" ? (
            <Button iconLeft={<Plus className="size-4" aria-hidden />} onClick={() => setCreateOpen(true)}>
              New campaign
            </Button>
          ) : undefined
        }
      />
      <Tabs
        items={[
          { key: "campaigns", label: "Campaigns", count: campaigns.data?.length },
          { key: "templates", label: "Templates" },
          { key: "suppressions", label: "Suppressions" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as typeof tab)}
      />

      {tab === "campaigns" && (
        <QueryBoundary query={campaigns} loading={<SkeletonText lines={5} />}>
          <DataTable
            columns={columns}
            rows={campaigns.data ?? []}
            rowKey={(row) => row.id}
            onRowClick={(row) => setDetailId(row.id)}
            emptyState={
              <EmptyState
                icon={<Megaphone className="size-6" aria-hidden />}
                title="No campaigns yet"
                body={
                  canManage
                    ? "Draft your first send — pick an audience, write variant A (and B if you want a test), then schedule it."
                    : "Campaigns your team drafts will appear here."
                }
              />
            }
          />
        </QueryBoundary>
      )}
      {tab === "templates" && <TemplatesPanel canManage={canManage} />}
      {tab === "suppressions" && <SuppressionsPanel />}

      {detail !== null && <CampaignDetailDrawer campaign={detail} canManage={canManage} onClose={() => setDetailId(null)} />}
      <NewCampaignDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
