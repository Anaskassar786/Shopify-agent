import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationPage } from "./AutomationPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import type { WorkflowDetailResponse, WorkflowRowDto, WorkflowRunsResponse } from "../lib/api-types";

/**
 * M6 Automation hub: the workflows workspace drives real HTTP wiring —
 * create writes a minimal one-trigger definition, the canvas state machine
 * gates Activate on the lint truth, and the run ledger reads back.
 */

function workflowRow(overrides: Partial<WorkflowRowDto> = {}): WorkflowRowDto {
  return {
    id: "wf-1",
    name: "Win back quiet customers",
    description: null,
    status: "DRAFT",
    activeVersionId: null,
    nextFireAt: null,
    createdByUserId: "u-1",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

function detailOf(row: WorkflowRowDto): WorkflowDetailResponse {
  return {
    workflow: row,
    versions: [
      {
        id: "ver-1",
        workflowId: row.id,
        version: 1,
        definition: { nodes: [{ id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } }], edges: [] },
        createdByUserId: "u-1",
        createdAt: row.createdAt,
      },
    ],
    activeDefinition: null,
  };
}

describe("Automation hub — workflows workspace", () => {
  it("lists workflows on the default tab and creates one with a minimal definition", async () => {
    const rows: WorkflowRowDto[] = [];
    const created = workflowRow();
    const handlers: StubHandlers = {
      get: { "/api/v1/workflows": () => rows },
      getWithMeta: {},
      post: {
        "/api/v1/workflows": () => {
          rows.push(created);
          return { workflow: created, version: detailOf(created).versions[0] };
        },
      },
      patch: {},
      put: {},
    };
    const { stub } = renderApp(<AutomationPage />, { route: "/automation", handlers });

    // Default tab is the workflows surface (empty state is honest).
    expect(await screen.findByText("No workflows yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^new$/i }));
    fireEvent.change(await screen.findByLabelText("Workflow name"), { target: { value: "Win back quiet customers" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/workflows", {
        name: "Win back quiet customers",
        definition: { nodes: [{ id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } }], edges: [] },
      }),
    );
    expect(await screen.findByText("Workflow created")).toBeInTheDocument();
    expect(await screen.findByText("Win back quiet customers")).toBeInTheDocument();
  });

  it("opens the builder, gates Activate on the lint truth, and activates a valid draft", async () => {
    const row = workflowRow();
    const detail = detailOf(row);
    const handlers: StubHandlers = {
      get: {
        "/api/v1/workflows": () => [row],
        "/api/v1/workflows/wf-1": () => detail,
      },
      getWithMeta: {},
      post: { "/api/v1/workflows/wf-1/activate": () => ({}) },
      patch: {},
      put: {},
    };
    const { stub } = renderApp(<AutomationPage />, { route: "/automation", handlers });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    // One trigger node, no conditions, nothing unreachable ⇒ zero issues.
    expect(await screen.findByTestId("workflow-canvas")).toBeInTheDocument();
    const activate = await screen.findByRole("button", { name: /^activate$/i });
    expect(activate).toBeEnabled();

    // Adding an unconnected node flips the lint truth and locks Activate.
    fireEvent.click(screen.getByRole("button", { name: /^condition$/i }));
    expect(await screen.findByText(/is not connected from the trigger/)).toBeInTheDocument();
    expect(activate).toBeDisabled();
    // Save also unlocks because the definition is dirty now.
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();

    // Select the node card on the canvas, then remove it through the side panel.
    const canvas = screen.getByTestId("workflow-canvas");
    fireEvent.click(within(canvas).getByText("condition"));
    fireEvent.click(await screen.findByRole("button", { name: /remove node/i }));
    await waitFor(() => expect(screen.queryByText(/is not connected from the trigger/)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^activate$/i }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/activate"));
  });

  it("reads the run ledger and expands a run into per-node steps", async () => {
    const row = workflowRow({ status: "ACTIVE", activeVersionId: "ver-1" });
    const detail: WorkflowDetailResponse = { ...detailOf(row), activeDefinition: detailOf(row).versions[0]!.definition };
    const runs: WorkflowRunsResponse = {
      runs: [
        {
          id: "run-1",
          workflowId: row.id,
          versionId: "ver-1",
          status: "FAILED",
          triggerKind: "MANUAL",
          triggerEventId: "manual:xyz",
          subject: null,
          resumeAt: null,
          resumeFromNodeId: null,
          error: "run subject has no customer email",
          startedAt: "2026-07-03T09:00:00.000Z",
          completedAt: "2026-07-03T09:00:04.000Z",
          createdAt: "2026-07-03T09:00:00.000Z",
        },
      ],
      total: 1,
    };
    const steps = {
      run: runs.runs[0],
      steps: [
        {
          id: "step-1",
          runId: "run-1",
          nodeId: "trigger",
          nodeKind: "TRIGGER",
          status: "COMPLETED",
          attempts: 1,
          detail: null,
          error: null,
          startedAt: "2026-07-03T09:00:00.000Z",
          completedAt: "2026-07-03T09:00:00.000Z",
          createdAt: "2026-07-03T09:00:00.000Z",
        },
      ],
    };
    const handlers: StubHandlers = {
      get: {
        "/api/v1/workflows": () => [row],
        "/api/v1/workflows/wf-1/runs/run-1/steps": () => steps,
        "/api/v1/workflows/wf-1/runs": () => runs,
        "/api/v1/workflows/wf-1": () => detail,
      },
      getWithMeta: {},
      post: {},
      patch: {},
      put: {},
    };
    renderApp(<AutomationPage />, { route: "/automation", handlers });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    fireEvent.click(await screen.findByRole("tab", { name: /run history/i }));
    expect(await screen.findByText("run subject has no customer email")).toBeInTheDocument();

    fireEvent.click(screen.getByText("manual"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findAllByText("COMPLETED")).not.toHaveLength(0);
  });
});
