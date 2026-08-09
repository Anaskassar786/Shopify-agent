import { describe, expect, it } from "vitest";
import {
  addNode,
  canConnect,
  connectNodes,
  graphFromDefinition,
  layoutGraph,
  lintGraph,
  nextNodeId,
  removeEdge,
  removeNode,
  replaceNodeConfig,
  serializeGraph,
  triggerNodeOf,
  updateNodeConfig,
  type BuilderGraph,
} from "./workflow-builder";

/** Minimal valid one-trigger graph — the shape POST /workflows creates. */
function starter(): BuilderGraph {
  return {
    nodes: [{ id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } }],
    edges: [],
  };
}

describe("workflow-builder: node ops", () => {
  it("derives unique kebab ids from kinds", () => {
    expect(nextNodeId("SEND_EMAIL", new Set())).toBe("send-email");
    expect(nextNodeId("SEND_EMAIL", new Set(["send-email"]))).toBe("send-email-2");
    expect(nextNodeId("CONDITION", new Set(["condition", "condition-2"]))).toBe("condition-3");
  });

  it("addNode stamps default config; update/patch/replace keep edges untouched", () => {
    let graph = addNode(starter(), "DELAY");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[1]).toMatchObject({ id: "delay", kind: "DELAY", config: { minutes: 60 } });

    graph = updateNodeConfig(graph, "delay", { minutes: 1440 });
    expect(graph.nodes[1]!.config["minutes"]).toBe(1440);

    graph = replaceNodeConfig(graph, "trigger", { kind: "SCHEDULE", cron: "0 9 * * *" });
    expect(triggerNodeOf(graph)?.config).toEqual({ kind: "SCHEDULE", cron: "0 9 * * *" });
  });

  it("removeNode prunes its edges and refuses the trigger", () => {
    let graph = addNode(starter(), "SEND_EMAIL");
    graph = connectNodes(graph, "trigger", "send-email");
    expect(graph.edges).toHaveLength(1);

    const refused = removeNode(graph, "trigger");
    expect(refused).toBe(graph); // structural node is immutable in the builder

    const removed = removeNode(graph, "send-email");
    expect(removed.nodes).toHaveLength(1);
    expect(removed.edges).toHaveLength(0); // no dangling connections
  });
});

describe("workflow-builder: connection discipline", () => {
  it("non-condition nodes own a single un-branched outgoing edge", () => {
    let graph = addNode(addNode(starter(), "SEND_EMAIL"), "TAG_CUSTOMER");
    expect(canConnect(graph, "trigger", "send-email")).toBe(true);
    graph = connectNodes(graph, "trigger", "send-email");
    expect(graph.edges[0]).toEqual({ from: "trigger", to: "send-email" });
    // Second outgoing from trigger is refused; self-loops and duplicates too.
    expect(canConnect(graph, "trigger", "tag-customer")).toBe(false);
    expect(canConnect(graph, "send-email", "send-email")).toBe(false);
    expect(canConnect(graph, "trigger", "send-email")).toBe(false);
  });

  it("condition edges auto-assign YES then NO, then cap at two", () => {
    let graph = addNode(addNode(addNode(starter(), "CONDITION"), "SEND_EMAIL"), "DELAY");
    graph = connectNodes(graph, "trigger", "condition");
    graph = connectNodes(graph, "condition", "send-email");
    expect(graph.edges.find((e) => e.from === "condition")?.branch).toBe("YES");
    graph = connectNodes(graph, "condition", "delay");
    expect(graph.edges.filter((e) => e.from === "condition").map((e) => e.branch)).toEqual(["YES", "NO"]);
    expect(canConnect(graph, "condition", "trigger")).toBe(false); // target is the trigger anyway
    graph = addNode(graph, "TAG_CUSTOMER");
    expect(canConnect(graph, "condition", "tag-customer")).toBe(false); // full
  });

  it("removeEdge removes exactly the named connection", () => {
    let graph = addNode(starter(), "SEND_EMAIL");
    graph = connectNodes(graph, "trigger", "send-email");
    expect(removeEdge(graph, "trigger", "send-email").edges).toHaveLength(0);
  });
});

describe("workflow-builder: lint (UX mirror of the server validator)", () => {
  it("flags missing YES/NO branches on conditions", () => {
    let graph = addNode(addNode(starter(), "CONDITION"), "SEND_EMAIL");
    graph = connectNodes(graph, "trigger", "condition");
    graph = connectNodes(graph, "condition", "send-email"); // YES only
    const codes = lintGraph(graph).map((issue) => issue.code);
    expect(codes).toContain("MISSING_BRANCH");
  });

  it("flags unreachable nodes and cycles", () => {
    let graph = addNode(starter(), "TAG_CUSTOMER"); // never connected
    expect(lintGraph(graph).some((issue) => issue.code === "UNREACHABLE")).toBe(true);

    let cycled = addNode(addNode(starter(), "CONDITION"), "SEND_EMAIL");
    cycled = connectNodes(cycled, "trigger", "condition");
    cycled = connectNodes(cycled, "condition", "send-email");
    // hand-forge a loop edge the UI would refuse, to prove the lint sees it
    cycled = { ...cycled, edges: [...cycled.edges, { from: "send-email", to: "condition" }] };
    expect(lintGraph(cycled).some((issue) => issue.code === "CYCLE")).toBe(true);

    expect(lintGraph(graphFromDefinition(serializeGraph(starter())))).toHaveLength(0);
  });
});

describe("workflow-builder: layout + serialization", () => {
  it("layers nodes by longest path from the trigger, deterministically", () => {
    let graph = addNode(addNode(addNode(starter(), "CONDITION"), "SEND_EMAIL"), "DELAY");
    graph = connectNodes(graph, "trigger", "condition");
    graph = connectNodes(graph, "condition", "send-email");
    const layout = layoutGraph(graph);
    const trigger = layout.positions.get("trigger");
    const condition = layout.positions.get("condition");
    const email = layout.positions.get("send-email");
    const delay = layout.positions.get("delay"); // unreachable → trailing lane
    expect(trigger!.x).toBeLessThan(condition!.x);
    expect(condition!.x).toBeLessThan(email!.x);
    expect(delay!.x).toBeGreaterThan(email!.x);
    expect(layoutGraph(graph)).toEqual(layout); // pure + stable
  });

  it("serialize → parse round-trips losslessly", () => {
    let graph = addNode(starter(), "SEND_EMAIL");
    graph = updateNodeConfig(graph, "send-email", { subject: "Hi {{customer.firstName}}", bodyText: "Body" });
    graph = connectNodes(graph, "trigger", "send-email");
    const roundTripped = graphFromDefinition(serializeGraph(graph));
    expect(roundTripped.nodes).toEqual(graph.nodes);
    expect(roundTripped.edges).toEqual(graph.edges);
    // Branch key is OMITTED (never null) for un-branched edges — wire contract.
    expect(Object.keys(serializeGraph(graph).edges[0]!)).not.toContain("branch");
  });
});
