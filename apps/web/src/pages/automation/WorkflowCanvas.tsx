import type { ReactNode } from "react";
import { Badge } from "@profit/ui";
import {
  CANVAS_PADDING,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  NODE_KIND_META,
  type BuilderGraph,
} from "./workflow-builder";

/**
 * Workflow canvas (M6): a deterministic, layered rendering of the DAG —
 * real SVG edges under absolutely-positioned node cards. Clicking a node
 * selects it (config opens in the side panel); in connect mode the canvas
 * highlights legal targets and completes edges through the pure builder.
 */

const KIND_BADGE_TONE: Record<string, "info" | "ai" | "success" | "warning" | "neutral"> = {
  TRIGGER: "ai",
  CONDITION: "warning",
  DELAY: "neutral",
  SEND_EMAIL: "info",
  SEND_SMS: "info",
  TAG_CUSTOMER: "success",
  CREATE_DISCOUNT: "success",
};

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(40, Math.abs(endX - startX) / 2);
  return `M ${String(startX)} ${String(startY)} C ${String(startX + bend)} ${String(startY)}, ${String(endX - bend)} ${String(endY)}, ${String(endX)} ${String(endY)}`;
}

export function WorkflowCanvas({
  graph,
  selectedNodeId,
  connectFromId,
  onSelectNode,
  onConnectNodes,
  onRemoveEdge,
}: {
  readonly graph: BuilderGraph;
  readonly selectedNodeId: string | null;
  /** When set, the next clicked node becomes the target of a new edge. */
  readonly connectFromId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onConnectNodes: (fromId: string, toId: string) => void;
  readonly onRemoveEdge: (fromId: string, toId: string) => void;
}): ReactNode {
  const layout = layoutGraph(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <div
      className="relative overflow-auto rounded-lg border border-subtle bg-surface"
      style={{ minHeight: 320 }}
      aria-label="Workflow canvas"
      data-testid="workflow-canvas"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="absolute inset-0"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          <defs>
            <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0.5 L 7.5 4 L 0 7.5 z" fill="var(--color-faint)" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (from === undefined || to === undefined) return null;
            return (
              <g key={`${edge.from}->${edge.to}`}>
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  stroke={edge.branch === "YES" ? "var(--color-success)" : edge.branch === "NO" ? "var(--color-danger)" : "var(--color-faint)"}
                  strokeWidth="1.5"
                  markerEnd="url(#wf-arrow)"
                />
                {edge.branch !== undefined && (
                  <text
                    x={(from.x + NODE_WIDTH + to.x) / 2}
                    y={(from.y + to.y) / 2 + NODE_HEIGHT / 2 - 6}
                    textAnchor="middle"
                    className="fill-[var(--color-muted)] text-[10px] font-semibold"
                  >
                    {edge.branch}
                  </text>
                )}
                {/* fat invisible hit-path so the connection itself is removable */}
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="12"
                  className="cursor-pointer"
                  onClick={() => onRemoveEdge(edge.from, edge.to)}
                >
                  <title>{`Disconnect ${edge.from} → ${edge.to}`}</title>
                </path>
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const pos = layout.positions.get(node.id) ?? { x: CANVAS_PADDING, y: CANVAS_PADDING };
          const selected = node.id === selectedNodeId;
          const connectTarget = connectFromId !== null && node.id !== connectFromId;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => {
                if (connectFromId !== null && nodeById.get(connectFromId) !== undefined) {
                  onConnectNodes(connectFromId, node.id);
                } else {
                  onSelectNode(node.id);
                }
              }}
              className={[
                "absolute flex flex-col gap-1 rounded-lg border bg-surface-raised px-3 py-2 text-left shadow-xs transition-all",
                "focus-visible:outline-2 focus-visible:outline-primary",
                selected ? "border-primary ring-2 ring-primary/30" : "border-subtle hover:border-strong",
                connectTarget ? "cursor-crosshair border-dashed" : "",
              ].join(" ")}
              style={{ left: pos.x, top: pos.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
              aria-pressed={selected}
              data-node-id={node.id}
            >
              <span className="flex items-center justify-between gap-2">
                <Badge tone={KIND_BADGE_TONE[node.kind] ?? "neutral"}>{NODE_KIND_META[node.kind].label}</Badge>
                {node.kind === "TRIGGER" && (
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">start</span>
                )}
              </span>
              <span className="truncate font-mono text-[11px] text-muted">{node.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function summarizeNodeConfig(node: { kind: string; config: Readonly<Record<string, unknown>> }): string {
  const c = node.config;
  switch (node.kind) {
    case "TRIGGER":
      if (c["kind"] === "SCHEDULE") return `cron ${String(c["cron"] ?? "")} (UTC)`;
      if (c["kind"] === "EVENT") return `on ${String(c["topic"] ?? "")}`;
      return "Runs when you click Run once";
    case "CONDITION":
      return `${String(c["field"] ?? "")} ${String(c["operator"] ?? "")} ${String(c["value"] ?? "")}`;
    case "DELAY":
      return `wait ${String(c["minutes"] ?? "")} min`;
    case "SEND_EMAIL":
      return typeof c["subject"] === "string" && c["subject"] !== "" ? c["subject"] : "(no subject yet)";
    case "SEND_SMS":
      return "text message";
    case "TAG_CUSTOMER":
      return typeof c["tag"] === "string" && c["tag"] !== "" ? `tag “${c["tag"]}”` : "(no tag yet)";
    case "CREATE_DISCOUNT":
      return `${String(c["percentOff"] ?? "")}% off · ${String(c["code"] ?? "")}`;
    default:
      return "";
  }
}
