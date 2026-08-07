import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, GitBranch, Pause, Play, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  Select,
  SkeletonText,
  Tabs,
  Textarea,
  useToast,
} from "@profit/ui";
import { useAuth } from "../../lib/auth-context";
import { ApiError } from "../../lib/api-client";
import {
  useCreateWorkflowMutation,
  useSaveWorkflowMutation,
  useWorkflowActionMutation,
  useWorkflowQuery,
  useWorkflowsQuery,
  type WorkflowLifecycleAction,
} from "../../lib/workflow-queries";
import type { WorkflowDefinitionDto, WorkflowDetailResponse, WorkflowRowDto, WorkflowStatusDto } from "../../lib/api-types";
import { QueryBoundary } from "../../components/QueryBoundary";
import {
  ADDABLE_KINDS,
  addNode,
  canConnect,
  connectNodes,
  graphFromDefinition,
  lintGraph,
  NODE_KIND_META,
  outgoingOf,
  removeEdge,
  removeNode,
  replaceNodeConfig,
  serializeGraph,
  triggerNodeOf,
  updateNodeConfig,
  type BuilderGraph,
} from "./workflow-builder";
import { summarizeNodeConfig, WorkflowCanvas } from "./WorkflowCanvas";
import { NodeConfigForm } from "./NodeConfigForm";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";

const STATUS_TONE: Record<WorkflowStatusDto, "success" | "warning" | "neutral" | "info"> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PAUSED: "warning",
  ARCHIVED: "neutral",
};

/* ── workflow list (left column) ─────────────────────────────────────────── */

function WorkflowList({
  rows,
  selectedId,
  onSelect,
  onCreate,
  canManage,
}: {
  readonly rows: readonly WorkflowRowDto[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
  readonly canManage: boolean;
}): ReactNode {
  return (
    <Card>
      <CardHeader
        title="Workflows"
        subtitle="Versioned playbooks that run against live store events"
        actions={
          canManage ? (
            <Button size="sm" iconLeft={<Plus className="size-3.5" aria-hidden />} onClick={onCreate}>
              New
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-1 px-3 py-2">
        {rows.length === 0 && (
          <EmptyState
            icon={<GitBranch className="size-6" aria-hidden />}
            title="No workflows yet"
            body={
              canManage
                ? "Create your first playbook — a welcome series, a win-back, a tag-on-spend — and watch every run here."
                : "Workflows your team builds will appear here."
            }
          />
        )}
        {rows.map((row) => {
          const active = row.id === selectedId;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row.id)}
              aria-pressed={active}
              className={[
                "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2.5 text-left transition-colors",
                "focus-visible:outline-2 focus-visible:outline-primary",
                active ? "bg-primary-soft" : "hover:bg-surface-raised",
              ].join(" ")}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{row.name}</span>
                {row.nextFireAt !== null && row.status === "ACTIVE" && (
                  <span className="block truncate text-[11px] text-faint">scheduled flow</span>
                )}
              </span>
              <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
            </button>
          );
        })}
      </CardBody>
    </Card>
  );
}

/* ── selected workflow workspace ─────────────────────────────────────────── */

function WorkflowWorkspace({
  detail,
  canManage,
}: {
  readonly detail: WorkflowDetailResponse;
  readonly canManage: boolean;
}): ReactNode {
  const toast = useToast();
  const save = useSaveWorkflowMutation();
  const actions = useWorkflowActionMutation();

  const baselineDefinition = useMemo<WorkflowDefinitionDto | null>(
    () => detail.activeDefinition ?? detail.versions[0]?.definition ?? null,
    [detail],
  );

  const [graph, setGraph] = useState<BuilderGraph | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);

  // Hydrate once from the server truth; re-hydrate whenever a saved version
  // rolls over (PUT bumps versions[0] ⇒ this effect re-seeds the canvas).
  useEffect(() => {
    setGraph(baselineDefinition !== null ? graphFromDefinition(baselineDefinition) : null);
    setNameDraft(detail.workflow.name);
    setDescriptionDraft(detail.workflow.description ?? "");
  }, [baselineDefinition, detail.workflow.name, detail.workflow.description]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectFromId, setConnectFromId] = useState<string | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<"builder" | "runs">("builder");
  const [archiveOpen, setArchiveOpen] = useState(false);

  const issues = useMemo(() => (graph !== null ? lintGraph(graph) : []), [graph]);

  const definitionDirty = useMemo(() => {
    if (graph === null || baselineDefinition === null) return false;
    return JSON.stringify(serializeGraph(graph)) !== JSON.stringify(baselineDefinition);
  }, [graph, baselineDefinition]);

  const metadataDirty =
    nameDraft !== null &&
    descriptionDraft !== null &&
    (nameDraft !== detail.workflow.name || descriptionDraft !== (detail.workflow.description ?? ""));
  const dirty = definitionDirty || metadataDirty;

  const archived = detail.workflow.status === "ARCHIVED";
  const editable = canManage && !archived && graph !== null;

  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const triggerId = graph !== null ? (triggerNodeOf(graph)?.id ?? null) : null;

  const patchGraph = (next: BuilderGraph): void => setGraph(next);

  const onSave = (): void => {
    if (!editable || nameDraft === null || descriptionDraft === null) return;
    const body: { workflowId: string; name?: string; description?: string; definition?: WorkflowDefinitionDto } = {
      workflowId: detail.workflow.id,
    };
    if (metadataDirty) {
      body.name = nameDraft.trim();
      body.description = descriptionDraft.trim();
    }
    if (definitionDirty) body.definition = serializeGraph(graph);
    save.mutate(body, {
      onSuccess: () => toast.success("Workflow saved", "A new immutable version was recorded."),
      onError: (error) => toast.error("Workflow could not be saved", error.message),
    });
  };

  const runAction = (action: WorkflowLifecycleAction, confirm?: string): void => {
    actions.mutate(
      { workflowId: detail.workflow.id, action },
      {
        onSuccess: () => {
          if (confirm !== undefined) toast.success(confirm);
        },
        onError: (error: ApiError) =>
          toast.error(
            `${action.charAt(0).toUpperCase() + action.slice(1)} failed`,
            error.message,
          ),
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <span className="truncate">{detail.workflow.name}</span>
              <Badge tone={STATUS_TONE[detail.workflow.status]}>{detail.workflow.status}</Badge>
              <span className="text-[11px] font-normal text-faint">
                v{String(detail.versions[0]?.version ?? 1)}
                {detail.activeDefinition === null ? " · never activated" : ""}
              </span>
            </span>
          }
          subtitle={detail.workflow.description ?? undefined}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {editable && (
                <Button size="sm" onClick={onSave} loading={save.isPending} disabled={!dirty}>
                  Save version
                </Button>
              )}
              {canManage && !archived && (
                <>
                  {(detail.workflow.status === "DRAFT" || detail.workflow.status === "PAUSED") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      iconLeft={<Play className="size-3.5" aria-hidden />}
                      disabled={dirty || issues.length > 0 || actions.isPending}
                      onClick={() => runAction("activate", "Workflow activated")}
                    >
                      Activate
                    </Button>
                  )}
                  {detail.workflow.status === "ACTIVE" && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        iconLeft={<Play className="size-3.5" aria-hidden />}
                        disabled={actions.isPending}
                        onClick={() => runAction("run", "Run queued — watch the ledger below")}
                      >
                        Run once
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconLeft={<Pause className="size-3.5" aria-hidden />}
                        disabled={actions.isPending}
                        onClick={() => runAction("pause", "Workflow paused")}
                      >
                        Pause
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    iconLeft={<Archive className="size-3.5" aria-hidden />}
                    disabled={actions.isPending}
                    onClick={() => setArchiveOpen(true)}
                  >
                    Archive
                  </Button>
                </>
              )}
            </div>
          }
        />
        {editable && (
          <CardBody className="grid gap-3 border-t border-subtle pt-4 sm:grid-cols-2">
            <Input value={nameDraft ?? ""} onChange={(event) => setNameDraft(event.target.value)} aria-label="Workflow name" maxLength={140} />
            <Input
              value={descriptionDraft ?? ""}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              aria-label="Workflow description"
              placeholder="What this playbook is for"
              maxLength={500}
            />
          </CardBody>
        )}
      </Card>

      <Tabs
        items={[
          { key: "builder", label: "Builder" },
          { key: "runs", label: "Run history" },
        ]}
        active={workspaceTab}
        onChange={(key) => setWorkspaceTab(key as "builder" | "runs")}
      />

      {workspaceTab === "runs" && <WorkflowRunsPanel workflowId={detail.workflow.id} />}

      {workspaceTab === "builder" && (
        <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="flex min-w-0 flex-col gap-3">
            {editable && (
              <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Add nodes">
                <span className="mr-1 text-xs font-medium text-muted">Add:</span>
                {ADDABLE_KINDS.map((kind) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant="secondary"
                    title={NODE_KIND_META[kind].hint}
                    onClick={() => {
                      if (graph !== null) patchGraph(addNode(graph, kind));
                    }}
                  >
                    {NODE_KIND_META[kind].label}
                  </Button>
                ))}
              </div>
            )}
            {issues.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2" aria-label="Definition issues">
                {issues.map((issue) => (
                  <li key={`${issue.code}-${issue.nodeId ?? "graph"}-${issue.message}`} className="text-xs leading-relaxed text-warning">
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {connectFromId !== null && (
              <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
                Connecting from <code className="font-mono">{connectFromId}</code> — click a target node on the canvas.
                Branch (YES/NO for conditions) is assigned automatically.
              </p>
            )}
            {graph !== null && (
              <WorkflowCanvas
                graph={graph}
                selectedNodeId={selectedNodeId}
                connectFromId={editable ? connectFromId : null}
                onSelectNode={setSelectedNodeId}
                onConnectNodes={(fromId, toId) => {
                  if (!editable || graph === null) return;
                  if (!canConnect(graph, fromId, toId)) {
                    toast.error("Not a legal connection", "Conditions take exactly two links (YES + NO); every other node takes one.");
                    setConnectFromId(null);
                    return;
                  }
                  patchGraph(connectNodes(graph, fromId, toId));
                  setConnectFromId(null);
                }}
                onRemoveEdge={(fromId, toId) => {
                  if (editable && graph !== null) patchGraph(removeEdge(graph, fromId, toId));
                }}
              />
            )}
          </div>

          <Card className="h-fit">
            <CardHeader
              title={selectedNode !== null ? NODE_KIND_META[selectedNode.kind].label : "Node"}
              subtitle={selectedNode !== null ? NODE_KIND_META[selectedNode.kind].hint : "Select a node on the canvas"}
            />
            <CardBody className="flex flex-col gap-4">
              {selectedNode === null ? (
                <EmptyState
                  icon={<GitBranch className="size-6" aria-hidden />}
                  title="Nothing selected"
                  body="Click a node card to edit what it does, or add nodes from the toolbar."
                />
              ) : (
                <>
                  <code className="rounded bg-surface-raised px-2 py-1 font-mono text-[11px] text-muted">{selectedNode.id}</code>
                  {editable && graph !== null ? (
                    <NodeConfigForm
                      node={selectedNode}
                      onPatchConfig={(patch) => patchGraph(updateNodeConfig(graph, selectedNode.id, patch))}
                      onReplaceConfig={(config) => patchGraph(replaceNodeConfig(graph, selectedNode.id, config))}
                    />
                  ) : (
                    <p className="text-xs text-muted">{summarizeNodeConfig(selectedNode)}</p>
                  )}
                  {editable && graph !== null && (
                    <div className="flex flex-col gap-2 border-t border-subtle pt-3">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Connections</span>
                      {outgoingOf(graph, selectedNode.id).map((edge) => (
                        <div key={`${edge.from}->${edge.to}`} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-muted">
                            {edge.branch !== undefined ? `${edge.branch} → ` : "→ "}
                            <code className="font-mono">{edge.to}</code>
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => patchGraph(removeEdge(graph, edge.from, edge.to))}>
                            Disconnect
                          </Button>
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={connectFromId === selectedNode.id}
                        onClick={() => setConnectFromId(selectedNode.id)}
                      >
                        Connect to another node…
                      </Button>
                      {selectedNode.id !== triggerId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          iconLeft={<Trash2 className="size-3.5" aria-hidden />}
                          onClick={() => {
                            patchGraph(removeNode(graph, selectedNode.id));
                            setSelectedNodeId(null);
                          }}
                        >
                          Remove node
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => {
          setArchiveOpen(false);
          runAction("archive", "Workflow archived — its definition stays readable here");
        }}
        title="Archive this workflow?"
        body="Archiving stops all future runs and is permanent for this workflow. Its versions and run ledger stay readable."
        confirmLabel="Archive workflow"
        danger
      />
    </div>
  );
}

/* ── create dialog ───────────────────────────────────────────────────────── */

function NewWorkflowDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (workflowId: string) => void;
}): ReactNode {
  const toast = useToast();
  const create = useCreateWorkflowMutation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerKind, setTriggerKind] = useState<"MANUAL" | "SCHEDULE" | "EVENT">("MANUAL");
  const [cron, setCron] = useState("0 9 * * *");
  const [topic, setTopic] = useState("orders/create");

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const triggerConfig: Record<string, unknown> =
      triggerKind === "SCHEDULE" ? { kind: "SCHEDULE", cron } : triggerKind === "EVENT" ? { kind: "EVENT", topic } : { kind: "MANUAL" };
    create.mutate(
      {
        name: trimmed,
        ...(description.trim() !== "" ? { description: description.trim() } : {}),
        definition: { nodes: [{ id: "trigger", kind: "TRIGGER", config: triggerConfig }], edges: [] },
      },
      {
        onSuccess: (created) => {
          toast.success("Workflow created", "Add nodes on the canvas, then activate it.");
          onCreated(created.workflow.id);
          onClose();
          setName("");
          setDescription("");
          setTriggerKind("MANUAL");
        },
        onError: (error) => toast.error("Workflow could not be created", error.message),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New workflow"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} loading={create.isPending} disabled={name.trim() === ""}>
            Create workflow
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={140} autoFocus placeholder="Win back quiet customers" aria-label="Workflow name" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Description (optional)</span>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={500} aria-label="Workflow description" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">What starts a run</span>
          <Select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as typeof triggerKind)} aria-label="Trigger kind">
            <option value="MANUAL">Manual — you run it by hand</option>
            <option value="SCHEDULE">Schedule — recurring cron (UTC)</option>
            <option value="EVENT">Store event — Shopify webhook</option>
          </Select>
        </label>
        {triggerKind === "SCHEDULE" && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Cron expression (UTC)</span>
            <Input value={cron} onChange={(event) => setCron(event.target.value)} aria-label="Cron expression" />
          </label>
        )}
        {triggerKind === "EVENT" && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Event topic</span>
            <Input value={topic} onChange={(event) => setTopic(event.target.value)} aria-label="Event topic" placeholder="orders/create" />
          </label>
        )}
        <p className="text-[11px] leading-relaxed text-faint">
          You can change the trigger any time from its node on the canvas. Every save is a new immutable version — activation always replays validation server-side.
        </p>
      </div>
    </Modal>
  );
}

/* ── panel root ──────────────────────────────────────────────────────────── */

export function WorkflowsPanel(): ReactNode {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("automation:manage");
  const list = useWorkflowsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const detail = useWorkflowQuery(selectedId);

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <QueryBoundary query={list} loading={<SkeletonText lines={5} />}>
        <WorkflowList
          rows={list.data ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => setCreateOpen(true)}
          canManage={canManage}
        />
      </QueryBoundary>
      <div className="min-w-0">
        {selectedId === null ? (
          <Card>
            <CardBody>
              <EmptyState
                icon={<GitBranch className="size-6" aria-hidden />}
                title="Pick a workflow"
                body="Select one on the left to open its builder and run ledger — or create a new playbook."
              />
            </CardBody>
          </Card>
        ) : (
          <QueryBoundary query={detail} loading={<SkeletonText lines={8} />}>
            {detail.data !== undefined && (
              // key rolls on workflow id + head version ⇒ clean slate per server truth
              <WorkflowWorkspace
                key={`${detail.data.workflow.id}:${detail.data.versions[0]?.id ?? "draft"}`}
                detail={detail.data}
                canManage={canManage}
              />
            )}
          </QueryBoundary>
        )}
      </div>
      <NewWorkflowDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={setSelectedId} />
    </div>
  );
}
