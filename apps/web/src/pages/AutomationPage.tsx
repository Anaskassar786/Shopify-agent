import { useState, type ReactNode } from "react";
import { Tabs } from "@profit/ui";
import { PageHeader } from "../components/PageHeader";
import { AiGuardrailsPanel } from "./automation/AiGuardrailsPanel";
import { WorkflowsPanel } from "./automation/WorkflowsPanel";

/**
 * Automation hub (M6): one section, two truth sources sharing the
 * `automation:read/manage` permission domain —
 *   · Workflows     — the M6 visual Playbooks (DAG builder + run ledger).
 *   · AI guardrails — the M4 autonomy policy the decision engine obeys.
 * Workflows is the default surface: it is the hub this milestone builds.
 */
export function AutomationPage(): ReactNode {
  const [tab, setTab] = useState<"workflows" | "guardrails">("workflows");
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Automation"
        subtitle="Playbooks that act on live store events, plus the guardrails the AI engine can never cross."
      />
      <Tabs
        items={[
          { key: "workflows", label: "Workflows" },
          { key: "guardrails", label: "AI guardrails" },
        ]}
        active={tab}
        onChange={(key) => setTab(key as "workflows" | "guardrails")}
      />
      {tab === "workflows" ? <WorkflowsPanel /> : <AiGuardrailsPanel />}
    </div>
  );
}
