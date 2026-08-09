import { describe, expect, it } from "vitest";
import { ConditionField, ConditionOperator, WorkflowNodeKind, WorkflowTriggerKind } from "@profit/types";
import { successorsOf, topologicalOrder, triggerNodeOf, validateWorkflowDefinition } from "./dag";
import type { WorkflowDefinition } from "./definition";

/** Builder fixtures: a valid welcome-email graph used across cases. */
function validDefinition(): Record<string, unknown> {
  return {
    nodes: [
      { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: WorkflowTriggerKind.Manual } },
      {
        id: "is-vip",
        kind: WorkflowNodeKind.Condition,
        config: { field: ConditionField.CustomerTotalSpentCents, operator: ConditionOperator.GreaterThanOrEqual, value: 100_000 },
      },
      {
        id: "vip-mail",
        kind: WorkflowNodeKind.SendEmail,
        config: { subject: "Thank you, {{customer.firstName}}", bodyText: "We appreciate you, {{customer.firstName}}." },
      },
      {
        id: "wait",
        kind: WorkflowNodeKind.Delay,
        config: { minutes: 60 },
      },
      {
        id: "tag",
        kind: WorkflowNodeKind.TagCustomer,
        config: { tag: "vip" },
      },
    ],
    edges: [
      { from: "trigger", to: "is-vip" },
      { from: "is-vip", to: "vip-mail", branch: "YES" },
      { from: "is-vip", to: "wait", branch: "NO" },
      { from: "vip-mail", to: "wait" },
      { from: "wait", to: "tag" },
    ],
  };
}

describe("validateWorkflowDefinition — valid graphs", () => {
  it("accepts a rich valid graph", () => {
    const result = validateWorkflowDefinition(validDefinition());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.nodes).toHaveLength(5);
      expect(result.definition.edges).toHaveLength(5);
    }
  });

  it("accepts a minimal trigger+action graph", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "Hi", bodyText: "Body" } },
      ],
      edges: [{ from: "trigger", to: "mail" }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a schedule trigger with a valid cron", () => {
    const def = validDefinition() as {
      nodes: Array<{ id: string; config: unknown }>;
    };
    def.nodes[0]!.config = { kind: "SCHEDULE", cron: "0 9 * * 1" };
    expect(validateWorkflowDefinition(def).ok).toBe(true);
  });

  it("accepts an event trigger with a registered webhook topic", () => {
    const def = validDefinition() as { nodes: Array<{ config: unknown }> };
    def.nodes[0]!.config = { kind: "EVENT", topic: "orders/create" };
    expect(validateWorkflowDefinition(def).ok).toBe(true);
  });
});

describe("validateWorkflowDefinition — structural violations", () => {
  it("rejects missing trigger", () => {
    const result = validateWorkflowDefinition({
      nodes: [{ id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "x", bodyText: "y" } }],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("TRIGGER"))).toBe(true);
  });

  it("rejects two triggers", () => {
    const def = validDefinition() as { nodes: Array<unknown>; edges: Array<unknown> };
    def.nodes.push({ id: "trigger-2", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } });
    def.edges.push({ from: "trigger-2", to: "wait" });
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
  });

  it("rejects cycles", () => {
    const def = validDefinition() as { edges: Array<unknown> };
    def.edges.push({ from: "tag", to: "is-vip" });
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.message.toLowerCase().includes("cycle"))).toBe(true);
    }
  });

  it("rejects self-loops", () => {
    const def = validDefinition() as { edges: Array<unknown> };
    def.edges.push({ from: "tag", to: "tag" });
    expect(validateWorkflowDefinition(def).ok).toBe(false);
  });

  it("rejects edges to unknown nodes", () => {
    const def = validDefinition() as { edges: Array<unknown> };
    def.edges.push({ from: "tag", to: "ghost" });
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
  });

  it("rejects edges INTO the trigger", () => {
    const def = validDefinition() as { edges: Array<unknown> };
    def.edges.push({ from: "tag", to: "trigger" });
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
  });

  it("rejects unreachable nodes", () => {
    const def = validDefinition() as { nodes: Array<unknown> };
    def.nodes.push({ id: "orphan", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } });
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("unreachable"))).toBe(true);
  });

  it("rejects a condition without both branches", () => {
    const def = validDefinition() as { edges: Array<Record<string, unknown>> };
    def.edges = def.edges.filter((e) => !(e["from"] === "is-vip" && e["branch"] === "NO"));
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("YES and NO"))).toBe(true);
  });

  it("rejects condition edge without branch label", () => {
    const def = validDefinition() as { edges: Array<Record<string, unknown>> };
    const edge = def.edges.find((e) => e["from"] === "is-vip" && e["branch"] === "YES");
    delete edge?.["branch"];
    expect(validateWorkflowDefinition(def).ok).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate edges", () => {
    const def = validDefinition() as { edges: Array<unknown> };
    def.edges.push({ from: "vip-mail", to: "wait" });
    expect(validateWorkflowDefinition(def).ok).toBe(false);
  });
});

describe("validateWorkflowDefinition — config semantics", () => {
  it("rejects config that fails its kind schema", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "", bodyText: "" } },
      ],
      edges: [{ from: "trigger", to: "mail" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path.includes("mail"))).toBe(true);
  });

  it("rejects unknown template variables in email subject/body", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "Hi {{customer.ssn}}", bodyText: "ok" } },
      ],
      edges: [{ from: "trigger", to: "mail" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("customer.ssn"))).toBe(true);
  });

  it("rejects an unparseable schedule cron", () => {
    const def = validDefinition() as { nodes: Array<{ config: unknown }> };
    def.nodes[0]!.config = { kind: "SCHEDULE", cron: "not a cron" };
    const result = validateWorkflowDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path.includes("cron"))).toBe(true);
  });

  it("rejects bad node id format", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "Trigger Node!", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
      ],
      edges: [],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects sms config with html", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "sms", kind: WorkflowNodeKind.SendSms, config: { bodyText: "hi", bodyHtml: "<b>no</b>" } },
      ],
      edges: [{ from: "trigger", to: "sms" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects oversized delay", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "wait", kind: WorkflowNodeKind.Delay, config: { minutes: 999_999 } },
        { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "x" } },
      ],
      edges: [
        { from: "trigger", to: "wait" },
        { from: "wait", to: "tag" },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a delay with no successor", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "wait", kind: WorkflowNodeKind.Delay, config: { minutes: 5 } },
      ],
      edges: [{ from: "trigger", to: "wait" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects multi-successor fan-out from non-condition nodes", () => {
    const result = validateWorkflowDefinition({
      nodes: [
        { id: "trigger", kind: WorkflowNodeKind.Trigger, config: { kind: "MANUAL" } },
        { id: "mail", kind: WorkflowNodeKind.SendEmail, config: { subject: "s", bodyText: "b" } },
        { id: "tag", kind: WorkflowNodeKind.TagCustomer, config: { tag: "t" } },
        { id: "tag2", kind: WorkflowNodeKind.TagCustomer, config: { tag: "u" } },
      ],
      edges: [
        { from: "trigger", to: "mail" },
        { from: "mail", to: "tag" },
        { from: "mail", to: "tag2" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.message.includes("fan out"))).toBe(true);
  });
});

describe("graph helpers", () => {
  it("topologicalOrder starts at the trigger and covers every node", () => {
    const result = validateWorkflowDefinition(validDefinition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order = topologicalOrder(result.definition);
    expect(order).not.toBeNull();
    expect(order?.[0]).toBe("trigger");
    expect(new Set(order)).toEqual(new Set(["trigger", "is-vip", "vip-mail", "wait", "tag"]));
  });

  it("successorsOf filters by branch", () => {
    const result = validateWorkflowDefinition(validDefinition());
    if (!result.ok) throw new Error("fixture invalid");
    const def: WorkflowDefinition = result.definition;
    const yes = successorsOf(def, "is-vip", "YES");
    const no = successorsOf(def, "is-vip", "NO");
    expect(yes.map((e) => e.to)).toEqual(["vip-mail"]);
    expect(no.map((e) => e.to)).toEqual(["wait"]);
  });

  it("triggerNodeOf returns the single trigger", () => {
    const result = validateWorkflowDefinition(validDefinition());
    if (!result.ok) throw new Error("fixture invalid");
    expect(triggerNodeOf(result.definition).id).toBe("trigger");
  });
});
