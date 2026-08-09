import { WorkflowNodeKind, WorkflowTriggerKind } from "@profit/types";
import {
  nodeConfigSchemaFor,
  workflowDefinitionSchema,
  type TriggerConfig,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeConfig,
} from "./definition";
import { validateTemplateVars } from "./template";
import { parseCron } from "./cron";

/**
 * DAG validation + traversal (M6). Structural rules enforced here (BEFORE a
 * version can be saved):
 *   - exactly one TRIGGER root with zero incoming edges;
 *   - every node reachable from the trigger (no dead config the UI can't show);
 *   - acyclic (a cycle would let a node run twice, breaking the run+node
 *     uniqueness the checkpoints rely on);
 *   - CONDITION nodes own their YES/NO branch labels (no duplicate labels,
 *     no branch labels on non-condition edges);
 *   - every config parses its kind schema AND its template variables resolve
 *     against the known variable catalog;
 *   - SCHEDULE triggers carry a parseable cron expression.
 */

export interface DefinitionIssue {
  readonly path: string;
  readonly message: string;
}

export type DefinitionValidation =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly issues: readonly DefinitionIssue[] };

const MAX_ISSUES = 40;

export function validateWorkflowDefinition(raw: unknown): DefinitionValidation {
  const issues: DefinitionIssue[] = [];
  const add = (path: string, message: string): void => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add(issue.path.join(".") || "(root)", issue.message);
    }
    return { ok: false, issues };
  }
  const { nodes: rawNodes, edges } = parsed.data;

  // Distinct node ids.
  const ids = new Set<string>();
  for (const node of rawNodes) {
    if (ids.has(node.id)) add(`nodes.${node.id}`, `duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  if (issues.length > 0) return { ok: false, issues };
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of rawNodes) {
    const configResult = nodeConfigSchemaFor(node.kind).safeParse(node.config);
    if (!configResult.success) {
      for (const issue of configResult.error.issues) {
        add(`nodes.${node.id}.config.${issue.path.join(".")}`, issue.message);
      }
      continue;
    }
    nodeById.set(node.id, {
      id: node.id,
      kind: node.kind,
      config: configResult.data,
    } as WorkflowNode);
  }
  if (issues.length > 0) return { ok: false, issues };

  const definition: WorkflowDefinition = {
    nodes: [...nodeById.values()],
    edges: edges as readonly WorkflowEdge[],
  };

  // Trigger structural rules.
  const triggers = definition.nodes.filter((n) => n.kind === WorkflowNodeKind.Trigger);
  if (triggers.length !== 1) {
    add("nodes", `exactly one TRIGGER node required, found ${triggers.length}`);
    return { ok: false, issues };
  }
  const trigger = triggers[0]!;

  // Edge referential + branch-label rules.
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.from)) add(`edges`, `edge from unknown node "${edge.from}"`);
    if (!nodeById.has(edge.to)) add(`edges`, `edge to unknown node "${edge.to}"`);
    if (edge.from === edge.to) add("edges", `self-loop on "${edge.from}" is a cycle`);
    const fromNode = nodeById.get(edge.from);
    if (fromNode === undefined) continue;
    if (fromNode.kind === WorkflowNodeKind.Condition) {
      if (edge.branch === undefined) {
        add("edges", `edge from condition "${edge.from}" needs branch YES|NO`);
      }
    } else if (edge.branch !== undefined) {
      add("edges", `branch label allowed only on condition edges ("${edge.from}")`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // Incoming to trigger / condition branch uniqueness / fan-out limits.
  const edgeKey = new Set<string>();
  for (const edge of definition.edges) {
    if (edge.to === trigger.id) add("edges", `trigger "${trigger.id}" must have no incoming edges`);
    const key = `${edge.from}->${edge.to}:${edge.branch ?? ""}`;
    if (edgeKey.has(key)) add("edges", `duplicate edge ${key}`);
    edgeKey.add(key);
  }
  for (const node of definition.nodes) {
    const outgoing = definition.edges.filter((e) => e.from === node.id);
    if (node.kind === WorkflowNodeKind.Condition) {
      const labels = new Set(outgoing.map((e) => e.branch));
      if (outgoing.length !== 2 || labels.size !== 2) {
        add(`nodes.${node.id}`, "condition needs exactly two outgoing edges (YES and NO)");
      }
    } else if (node.kind !== WorkflowNodeKind.Trigger && outgoing.length > 1) {
      add(`nodes.${node.id}`, "only CONDITION nodes may fan out to multiple successors");
    }
    if (node.kind !== WorkflowNodeKind.Trigger && outgoing.length === 0) {
      // A terminal action node is legal (end of run); only flag non-terminal dead ends on DELAY.
      if (node.kind === WorkflowNodeKind.Delay) {
        add(`nodes.${node.id}`, "delay node must continue to at least one successor");
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // Acyclicity (Kahn) + reachability (BFS from the TRIGGER — Kahn roots
  // alone would hide orphan nodes behind their own 0-indegree).
  const order = topologicalOrder(definition);
  if (order === null) {
    add("edges", "graph contains a cycle");
    return { ok: false, issues };
  }
  const visited = new Set<string>([trigger.id]);
  const frontier = [trigger.id];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const edge of definition.edges.filter((e) => e.from === current)) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        frontier.push(edge.to);
      }
    }
  }
  if (visited.size !== definition.nodes.length) {
    const unreachable = definition.nodes.map((n) => n.id).filter((id) => !visited.has(id));
    add("nodes", `unreachable nodes: ${unreachable.join(", ")}`);
    return { ok: false, issues };
  }

  // Config semantics: templates + cron.
  for (const node of definition.nodes) {
    if (node.kind === WorkflowNodeKind.SendEmail) {
      const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.SendEmail];
      for (const unknownVar of [
        ...validateTemplateVars(config.subject),
        ...validateTemplateVars(config.bodyText),
        ...(config.bodyHtml !== undefined ? validateTemplateVars(config.bodyHtml) : []),
      ]) {
        add(`nodes.${node.id}.config`, `unknown template variable "${unknownVar}"`);
      }
    }
    if (node.kind === WorkflowNodeKind.SendSms) {
      const config = node.config as WorkflowNodeConfig[typeof WorkflowNodeKind.SendSms];
      for (const unknownVar of validateTemplateVars(config.bodyText)) {
        add(`nodes.${node.id}.config`, `unknown template variable "${unknownVar}"`);
      }
    }
    if (node.kind === WorkflowNodeKind.Trigger) {
      const config = node.config as TriggerConfig;
      if (config.kind === WorkflowTriggerKind.Schedule && parseCron(config.cron) === null) {
        add(`nodes.${node.id}.config.cron`, `unparseable cron expression "${config.cron}"`);
      }
    }
  }

  return issues.length === 0 ? { ok: true, definition } : { ok: false, issues };
}

/** Kahn topological order from the trigger root; null when a cycle exists. */
export function topologicalOrder(definition: WorkflowDefinition): string[] | null {
  const indegree = new Map<string, number>();
  for (const node of definition.nodes) indegree.set(node.id, 0);
  for (const edge of definition.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = definition.nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const edge of definition.edges.filter((e) => e.from === id)) {
      const next = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, next);
      if (next === 0) {
        queue.push(edge.to);
        queue.sort();
      }
    }
  }
  return order.length === definition.nodes.length ? order : null;
}

export function nodesById(definition: WorkflowDefinition): ReadonlyMap<string, WorkflowNode> {
  return new Map(definition.nodes.map((n) => [n.id, n]));
}

/** Successors of a node, optionally filtered to one condition branch. */
export function successorsOf(
  definition: WorkflowDefinition,
  nodeId: string,
  branch?: "YES" | "NO",
): readonly WorkflowEdge[] {
  return definition.edges.filter(
    (e) => e.from === nodeId && (branch === undefined || (e.branch ?? "") === branch),
  );
}

export function triggerNodeOf(definition: WorkflowDefinition): WorkflowNode {
  const trigger = definition.nodes.find((n) => n.kind === WorkflowNodeKind.Trigger);
  if (trigger === undefined) throw new Error("definition has no trigger node (validate first)");
  return trigger;
}
