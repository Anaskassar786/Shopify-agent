import type {
  WorkflowDefinitionDto,
  WorkflowEdgeDto,
  WorkflowNodeDto,
  WorkflowNodeKindDto,
  WorkflowTriggerKindDto,
} from "../../lib/api-types";

/**
 * Workflow builder core (M6) — PURE module: every graph edit, the layered
 * canvas layout and the pre-flight lint live here so the workspace components
 * stay declarative and the rules are unit-testable without a DOM.
 *
 * Authority boundary: these lints are a UX convenience ONLY. The server DAG
 * validator (packages/automation/dag.ts) is the single source of truth and
 * re-checks everything on save/activate — the client never bypasses it.
 */

export type BuilderNode = WorkflowNodeDto;
export type BuilderEdge = WorkflowEdgeDto;

export interface BuilderGraph {
  readonly nodes: readonly BuilderNode[];
  readonly edges: readonly BuilderEdge[];
}

export interface GraphIssue {
  readonly code:
    | "CYCLE"
    | "UNREACHABLE"
    | "MISSING_BRANCH"
    | "DANGLING_EDGE"
    | "BRANCH_ON_NON_CONDITION"
    | "TRIGGER_INCOMING";
  readonly message: string;
  readonly nodeId?: string;
}

/** Palette metadata shared by the add-menu and the config forms (one home). */
export const NODE_KIND_META: Readonly<Record<WorkflowNodeKindDto, { label: string; hint: string }>> = {
  TRIGGER: { label: "Trigger", hint: "What starts a run (exactly one per workflow)" },
  CONDITION: { label: "Condition", hint: "Branch runs on a fact: YES path and NO path" },
  DELAY: { label: "Wait", hint: "Pause the run, then continue automatically" },
  SEND_EMAIL: { label: "Send email", hint: "Delivered through your sender address with tracking" },
  SEND_SMS: { label: "Send SMS", hint: "Twilio delivery; requires the customer to have a phone number" },
  TAG_CUSTOMER: { label: "Tag customer", hint: "Write a tag onto the customer in Shopify" },
  CREATE_DISCOUNT: { label: "Create discount", hint: "Mint a real Shopify discount code" },
};

export const ADDABLE_KINDS: readonly WorkflowNodeKindDto[] = [
  "CONDITION",
  "DELAY",
  "SEND_EMAIL",
  "SEND_SMS",
  "TAG_CUSTOMER",
  "CREATE_DISCOUNT",
];

/** Template variables the renderer honours (closed catalog, packages/automation/template.ts). */
export const TEMPLATE_VARIABLES: readonly string[] = [
  "store.name",
  "store.domain",
  "customer.firstName",
  "customer.lastName",
  "customer.fullName",
  "customer.email",
  "customer.ordersCount",
  "customer.totalSpent",
  "campaign.name",
  "workflow.name",
  "unsubscribeUrl",
];

export function triggerNodeOf(graph: BuilderGraph): BuilderNode | null {
  return graph.nodes.find((node) => node.kind === "TRIGGER") ?? null;
}

/** Default config per kind — matches the floor of each zod schema in definition.ts. */
export function defaultConfigFor(kind: WorkflowNodeKindDto, triggerKind: WorkflowTriggerKindDto = "MANUAL"): Record<string, unknown> {
  switch (kind) {
    case "TRIGGER":
      if (triggerKind === "SCHEDULE") return { kind: "SCHEDULE", cron: "0 9 * * *" };
      if (triggerKind === "EVENT") return { kind: "EVENT", topic: "orders/create" };
      return { kind: "MANUAL" };
    case "CONDITION":
      return { field: "customer.ordersCount", operator: "GTE", value: 1 };
    case "DELAY":
      return { minutes: 60 };
    case "SEND_EMAIL":
      return { subject: "", bodyText: "" };
    case "SEND_SMS":
      return { bodyText: "" };
    case "TAG_CUSTOMER":
      return { tag: "" };
    case "CREATE_DISCOUNT":
      return { code: "", percentOff: 10, expiresInDays: 30 };
  }
}

/** Local, kebab-cased unique node id derived from the kind (matches nodeIdSchema). */
export function nextNodeId(kind: WorkflowNodeKindDto, existing: ReadonlySet<string>): string {
  const base = kind.toLowerCase().replaceAll("_", "-");
  if (!existing.has(base)) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${String(i)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}

export function addNode(graph: BuilderGraph, kind: WorkflowNodeKindDto): BuilderGraph {
  const id = nextNodeId(kind, new Set(graph.nodes.map((node) => node.id)));
  return {
    nodes: [...graph.nodes, { id, kind, config: defaultConfigFor(kind) }],
    edges: graph.edges,
  };
}

/** The trigger is structural (create made it); everything else is removable. */
export function removeNode(graph: BuilderGraph, nodeId: string): BuilderGraph {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.kind === "TRIGGER") return graph;
  return {
    nodes: graph.nodes.filter((candidate) => candidate.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  };
}

export function updateNodeConfig(
  graph: BuilderGraph,
  nodeId: string,
  patch: Readonly<Record<string, unknown>>,
): BuilderGraph {
  return {
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, config: { ...node.config, ...patch } } : node,
    ),
    edges: graph.edges,
  };
}

/** Wholesale config replacement (trigger-kind switches change the config SHAPE). */
export function replaceNodeConfig(
  graph: BuilderGraph,
  nodeId: string,
  config: Readonly<Record<string, unknown>>,
): BuilderGraph {
  return {
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, config: { ...config } } : node)),
    edges: graph.edges,
  };
}

export function renameNodeId(graph: BuilderGraph, nodeId: string, nextId: string): BuilderGraph {
  if (nextId === "" || graph.nodes.some((node) => node.id === nextId)) return graph;
  return {
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, id: nextId } : node)),
    edges: graph.edges.map((edge) => ({
      from: edge.from === nodeId ? nextId : edge.from,
      to: edge.to === nodeId ? nextId : edge.to,
      ...(edge.branch !== undefined ? { branch: edge.branch } : {}),
    })),
  };
}

export function outgoingOf(graph: BuilderGraph, nodeId: string): readonly BuilderEdge[] {
  return graph.edges.filter((edge) => edge.from === nodeId);
}

/**
 * Connect two nodes. Branch discipline is assigned here so it can never be
 * wrong in the UI: CONDITION nodes own a YES edge then a NO edge; every
 * other node kind has a single un-branched outgoing edge.
 */
export function canConnect(graph: BuilderGraph, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const from = graph.nodes.find((node) => node.id === fromId);
  const to = graph.nodes.find((node) => node.id === toId);
  if (from === undefined || to === undefined || to.kind === "TRIGGER") return false;
  if (graph.edges.some((edge) => edge.from === fromId && edge.to === toId)) return false;
  return from.kind === "CONDITION" ? outgoingOf(graph, fromId).length < 2 : outgoingOf(graph, fromId).length === 0;
}

export function connectNodes(graph: BuilderGraph, fromId: string, toId: string): BuilderGraph {
  if (!canConnect(graph, fromId, toId)) return graph;
  const from = graph.nodes.find((node) => node.id === fromId)!;
  if (from.kind !== "CONDITION") {
    return { nodes: graph.nodes, edges: [...graph.edges, { from: fromId, to: toId }] };
  }
  const outgoing = outgoingOf(graph, fromId);
  const branch: "YES" | "NO" = outgoing.some((edge) => edge.branch === "YES") ? "NO" : "YES";
  return { nodes: graph.nodes, edges: [...graph.edges, { from: fromId, to: toId, branch }] };
}

export function removeEdge(graph: BuilderGraph, fromId: string, toId: string): BuilderGraph {
  return {
    nodes: graph.nodes,
    edges: graph.edges.filter((edge) => !(edge.from === fromId && edge.to === toId)),
  };
}

export function graphFromDefinition(definition: WorkflowDefinitionDto): BuilderGraph {
  return { nodes: definition.nodes, edges: definition.edges };
}

/** Deterministic serialization: nodes/edges keep insertion order; branch omitted when absent. */
export function serializeGraph(graph: BuilderGraph): WorkflowDefinitionDto {
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, config: { ...node.config } })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.branch !== undefined ? { branch: edge.branch } : {}),
    })),
  };
}

/* ── pre-flight lint (UX mirror — server validator stays authoritative) ──── */

export function lintGraph(graph: BuilderGraph): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));

  const trigger = triggerNodeOf(graph);
  if (trigger !== null && graph.edges.some((edge) => edge.to === trigger.id)) {
    issues.push({ code: "TRIGGER_INCOMING", message: "The trigger can never have an incoming connection.", nodeId: trigger.id });
  }

  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push({ code: "DANGLING_EDGE", message: `Connection ${edge.from} → ${edge.to} points at a missing node.` });
    }
    const from = graph.nodes.find((node) => node.id === edge.from);
    if (from !== undefined && from.kind !== "CONDITION" && edge.branch !== undefined) {
      issues.push({ code: "BRANCH_ON_NON_CONDITION", message: `Only conditions carry YES/NO branches (${edge.from}).`, nodeId: edge.from });
    }
  }

  for (const node of graph.nodes) {
    if (node.kind !== "CONDITION") continue;
    const branches = new Set(outgoingOf(graph, node.id).map((edge) => edge.branch));
    if (!branches.has("YES")) issues.push({ code: "MISSING_BRANCH", message: `Condition “${node.id}” has no YES connection.`, nodeId: node.id });
    if (!branches.has("NO")) issues.push({ code: "MISSING_BRANCH", message: `Condition “${node.id}” has no NO connection.`, nodeId: node.id });
  }

  if (cycleExists(graph)) {
    issues.push({ code: "CYCLE", message: "The graph loops back on itself — runs could never finish." });
  }

  // Reachability (BFS from the trigger, cycle-safe by the visited set).
  if (trigger !== null) {
    const visited = new Set<string>([trigger.id]);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outgoingOf(graph, current)) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of graph.nodes) {
      if (node.kind !== "TRIGGER" && !visited.has(node.id)) {
        issues.push({ code: "UNREACHABLE", message: `“${node.id}” is not connected from the trigger — it would never run.`, nodeId: node.id });
      }
    }
  }

  return issues;
}

function cycleExists(graph: BuilderGraph): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const edge of outgoingOf(graph, id)) {
      if (visit(edge.to)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  return graph.nodes.some((node) => visit(node.id));
}

/* ── layered auto-layout (read-only pure geometry) ───────────────────────── */

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 84;
export const LAYER_GAP = 96;
export const ROW_GAP = 28;
export const CANVAS_PADDING = 24;

export interface LayoutResult {
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly width: number;
  readonly height: number;
}

/** Longest-path layering from the trigger: stable, cycle-guarded, deterministic. */
export function layoutGraph(graph: BuilderGraph): LayoutResult {
  const trigger = triggerNodeOf(graph);
  const layerOf = new Map<string, number>();
  if (trigger !== null) layerOf.set(trigger.id, 0);

  // Iterate longest-path relaxation; bounded by node count ⇒ cycle-safe.
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      const fromLayer = layerOf.get(edge.from);
      if (fromLayer === undefined) continue;
      const next = fromLayer + 1;
      const existing = layerOf.get(edge.to);
      if (existing === undefined || next > existing) {
        layerOf.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Nodes the trigger never reaches still render: park them in a trailing lane.
  for (const node of graph.nodes) {
    if (!layerOf.has(node.id)) layerOf.set(node.id, Math.max(0, ...layerOf.values()) + 1);
  }
  const maxLayer = Math.max(0, ...layerOf.values());

  const byLayer = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), node.id]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let height = CANVAS_PADDING * 2;
  for (const [layer, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, index) => {
      positions.set(id, {
        x: CANVAS_PADDING + layer * (NODE_WIDTH + LAYER_GAP),
        y: CANVAS_PADDING + index * (NODE_HEIGHT + ROW_GAP),
      });
    });
    height = Math.max(height, CANVAS_PADDING * 2 + ids.length * NODE_HEIGHT + (ids.length - 1) * ROW_GAP);
  }
  const width = CANVAS_PADDING * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * LAYER_GAP;
  return { positions, width, height: Math.max(height, CANVAS_PADDING * 2 + NODE_HEIGHT) };
}
