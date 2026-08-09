import { useState, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConditionField, ConditionOperator, ShopifyWebhookTopic } from "@profit/types";
import { NodeConfigForm } from "./NodeConfigForm";
import type { BuilderNode } from "./workflow-builder";

/**
 * M6 node configuration form — every kind renders bounded, honest inputs and
 * every edit funnels through onPatchConfig/onReplaceConfig (the workspace
 * turns those into draft graph writes; the server schemas stay the backstop).
 */

interface PatchCall {
  readonly kind: "patch" | "replace";
  readonly value: Record<string, unknown>;
}

function Harness({ node, calls }: { readonly node: BuilderNode; readonly calls: PatchCall[] }): ReactNode {
  const [current, setCurrent] = useState(node);
  return (
    <NodeConfigForm
      node={current}
      onPatchConfig={(patch) => {
        calls.push({ kind: "patch", value: patch });
        setCurrent((prev) => ({ ...prev, config: { ...prev.config, ...patch } }));
      }}
      onReplaceConfig={(config) => {
        calls.push({ kind: "replace", value: config });
        setCurrent((prev) => ({ ...prev, config: { ...config } }));
      }}
    />
  );
}

function renderForm(node: BuilderNode): PatchCall[] {
  const calls: PatchCall[] = [];
  render(<Harness node={node} calls={calls} />);
  return calls;
}

function nodeOf(kind: BuilderNode["kind"], config: Record<string, unknown>): BuilderNode {
  return { id: kind.toLowerCase().replaceAll("_", "-"), kind, config };
}

describe("NodeConfigForm — trigger", () => {
  it("switches trigger kinds by replacing the config shape and edits each shape", () => {
    const calls = renderForm(nodeOf("TRIGGER", { kind: "MANUAL" }));

    // MANUAL renders only the kind picker.
    expect(screen.getByLabelText("Trigger kind")).toHaveValue("MANUAL");
    expect(screen.queryByLabelText("Cron expression")).not.toBeInTheDocument();

    // SCHEDULE replaces the config wholesale and reveals the cron input.
    fireEvent.change(screen.getByLabelText("Trigger kind"), { target: { value: "SCHEDULE" } });
    expect(calls.at(-1)).toEqual({ kind: "replace", value: { kind: "SCHEDULE", cron: "0 9 * * *" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "0 9 * * 1" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { cron: "0 9 * * 1" } });

    // EVENT reveals the topic picker with every Shopify topic the engine honours.
    fireEvent.change(screen.getByLabelText("Trigger kind"), { target: { value: "EVENT" } });
    expect(calls.at(-1)).toEqual({ kind: "replace", value: { kind: "EVENT", topic: "orders/create" } });
    const topic = screen.getByLabelText("Event topic");
    expect(topic).toHaveValue("orders/create");
    fireEvent.change(topic, { target: { value: ShopifyWebhookTopic.CustomersUpdate } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { topic: ShopifyWebhookTopic.CustomersUpdate } });
  });
});

describe("NodeConfigForm — condition", () => {
  it("adapts the compare input to the field type and re-seeds the value", () => {
    const calls = renderForm(nodeOf("CONDITION", { field: ConditionField.CustomerOrdersCount, operator: "GTE", value: 1 }));

    // Numeric field ⇒ number input.
    const numeric = screen.getByLabelText("Condition value");
    expect(numeric).toHaveAttribute("type", "number");
    fireEvent.change(numeric, { target: { value: "5" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { value: 5 } });

    // Operator select carries the human labels.
    fireEvent.change(screen.getByLabelText("Condition operator"), { target: { value: ConditionOperator.Contains } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { operator: "CONTAINS" } });

    // Boolean field ⇒ true/false select that writes a real boolean.
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: ConditionField.CustomerAcceptsMarketing } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { field: ConditionField.CustomerAcceptsMarketing, value: true } });
    const boolSelect = screen.getByLabelText("Condition value");
    expect(boolSelect).toHaveValue("true");
    fireEvent.change(boolSelect, { target: { value: "false" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { value: false } });

    // String field ⇒ free text (tag placeholder guides the operator).
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: ConditionField.CustomerTag } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { field: ConditionField.CustomerTag, value: "" } });
    const text = screen.getByLabelText("Condition value");
    expect(text).toHaveAttribute("placeholder", "vip");
    fireEvent.change(text, { target: { value: "vip" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { value: "vip" } });

    // Non-tag string field gets the currency placeholder instead.
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: ConditionField.EventCurrency } });
    expect(screen.getByLabelText("Condition value")).toHaveAttribute("placeholder", "USD");
    expect(screen.getByText(/YES runs when the check passes/)).toBeInTheDocument();
  });
});

describe("NodeConfigForm — wait", () => {
  it("shows human-readable hints and clamps the minutes floor", () => {
    const calls = renderForm(nodeOf("DELAY", { minutes: 60 }));
    expect(screen.getByText(/≈ 1 hours/)).toBeInTheDocument();

    const input = screen.getByLabelText("Wait minutes");
    fireEvent.change(input, { target: { value: "2880" } });
    expect(screen.getByText(/≈ 2 days/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "30" } });
    expect(screen.getByText(/≈ 30 minutes/)).toBeInTheDocument();
    // Zero is floored to one minute — the engine never waits "nothing".
    fireEvent.change(input, { target: { value: "0" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { minutes: 1 } });
  });
});

describe("NodeConfigForm — messaging nodes", () => {
  it("edits email fields and treats a blank HTML body as absent", () => {
    const calls = renderForm(nodeOf("SEND_EMAIL", { subject: "", bodyText: "" }));

    fireEvent.change(screen.getByLabelText("Email subject"), { target: { value: "We miss you" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { subject: "We miss you" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Plain body" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { bodyText: "Plain body" } });

    const html = screen.getByLabelText("Email HTML body");
    fireEvent.change(html, { target: { value: "<p>Hi</p>" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { bodyHtml: "<p>Hi</p>" } });
    fireEvent.change(html, { target: { value: "" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { bodyHtml: undefined } });

    // Personalization cheat-sheet expands to the closed variable catalog.
    fireEvent.click(screen.getByRole("button", { name: /personalization variables/i }));
    expect(screen.getByText("{{customer.firstName}}")).toBeInTheDocument();
    expect(screen.getByText("{{unsubscribeUrl}}")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /personalization variables/i }));
    expect(screen.queryByText("{{customer.firstName}}")).not.toBeInTheDocument();
  });

  it("edits the SMS body and shows the compliance hint", () => {
    const calls = renderForm(nodeOf("SEND_SMS", { bodyText: "" }));
    expect(screen.getByText(/unsubscribe line is appended automatically/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("SMS body"), { target: { value: "Still thinking it over?" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { bodyText: "Still thinking it over?" } });
  });
});

describe("NodeConfigForm — Shopify action nodes", () => {
  it("edits the customer tag", () => {
    const calls = renderForm(nodeOf("TAG_CUSTOMER", { tag: "" }));
    fireEvent.change(screen.getByLabelText("Customer tag"), { target: { value: "won-back" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { tag: "won-back" } });
  });

  it("uppercases discount codes as typed and rounds the numeric bounds", () => {
    const calls = renderForm(nodeOf("CREATE_DISCOUNT", { code: "", percentOff: 10, expiresInDays: 30 }));
    fireEvent.change(screen.getByLabelText("Discount code"), { target: { value: "winback-10" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { code: "WINBACK-10" } });
    fireEvent.change(screen.getByLabelText("Percent off"), { target: { value: "12.6" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { percentOff: 13 } });
    fireEvent.change(screen.getByLabelText("Expires after days"), { target: { value: "14" } });
    expect(calls.at(-1)).toEqual({ kind: "patch", value: { expiresInDays: 14 } });
  });
});
