import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationPage } from "./AutomationPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import type {
  WorkflowDefinitionDto,
  WorkflowDetailResponse,
  WorkflowRowDto,
} from "../lib/api-types";

/**
 * M6 workflow canvas — the interactive builder surface: palette adds, the
 * connect-mode state machine with automatic YES/NO branch discipline, edge
 * removal from both the canvas hit-path and the side panel, metadata saves,
 * and the read-only view with lifecycle actions for a live workflow.
 */

function workflowRow(overrides: Partial<WorkflowRowDto> = {}): WorkflowRowDto {
  return {
    id: "wf-1",
    name: "Win back quiet customers",
    description: "Chase customers gone quiet for 60 days",
    status: "DRAFT",
    activeVersionId: null,
    nextFireAt: null,
    createdByUserId: "u-1",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

function definitionOf(): WorkflowDefinitionDto {
  return { nodes: [{ id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } }], edges: [] };
}

function detailOf(row: WorkflowRowDto, definition: WorkflowDefinitionDto = definitionOf()): WorkflowDetailResponse {
  return {
    workflow: row,
    versions: [
      {
        id: "ver-1",
        workflowId: row.id,
        version: 1,
        definition,
        createdByUserId: "u-1",
        createdAt: row.createdAt,
      },
    ],
    activeDefinition: null,
  };
}

function canvasEdges(): number {
  return screen.getByTestId("workflow-canvas").querySelectorAll('path[stroke-width="12"]').length;
}

function graphHandlers(row: WorkflowRowDto, definition: WorkflowDefinitionDto): StubHandlers {
  // The stubs keep the server truth current (as the real backend would) so
  // post-save invalidations rehydrate the workspace from the newest version.
  let currentRow = row;
  let currentDefinition = definition;
  let version = 1;
  return {
    get: {
      "/api/v1/workflows": () => [currentRow],
      "/api/v1/workflows/wf-1": () => {
        const detail = detailOf(currentRow, currentDefinition);
        return { ...detail, versions: [{ ...detail.versions[0]!, id: `ver-${String(version)}`, version }] };
      },
    },
    getWithMeta: {},
    post: {},
    patch: {},
    put: {
      "/api/v1/workflows/wf-1": (body) => {
        const next = body as { readonly name?: string; readonly description?: string; readonly definition?: WorkflowDefinitionDto };
        if (next.definition !== undefined) {
          version += 1;
          currentDefinition = next.definition;
        }
        currentRow = { ...currentRow, name: next.name ?? currentRow.name, description: next.description ?? currentRow.description };
        return { workflow: currentRow, version: { ...detailOf(currentRow, currentDefinition).versions[0]!, id: `ver-${String(version)}`, version } };
      },
    },
  };
}

describe("Automation hub — canvas interactions", () => {
  it("connects nodes with automatic branch discipline and rejects an illegal link", async () => {
    const row = workflowRow();
    renderApp(<AutomationPage />, { route: "/automation", handlers: graphHandlers(row, definitionOf()) });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    const canvas = await screen.findByTestId("workflow-canvas");

    // Palette adds nodes; the trigger stays the only structural one.
    fireEvent.click(screen.getByRole("button", { name: /^wait$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^condition$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^send email$/i }));
    expect(within(canvas).getByText("delay")).toBeInTheDocument();
    expect(within(canvas).getByText("send-email")).toBeInTheDocument();

    // trigger → wait: a plain un-branched edge.
    fireEvent.click(within(canvas).getByText("trigger"));
    fireEvent.click(screen.getByRole("button", { name: /connect to another node/i }));
    expect(screen.getByText(/Connecting from/)).toBeInTheDocument();
    fireEvent.click(within(canvas).getByText("delay"));
    expect(canvasEdges()).toBe(1);

    // A second trigger link is illegal (single outgoing edge) — honest toast, no edge.
    fireEvent.click(within(canvas).getByText("trigger"));
    fireEvent.click(screen.getByRole("button", { name: /connect to another node/i }));
    fireEvent.click(within(canvas).getByText("condition"));
    expect(await screen.findByText("Not a legal connection")).toBeInTheDocument();
    expect(canvasEdges()).toBe(1);

    // Condition gets YES on the first link.
    fireEvent.click(within(canvas).getByText("condition"));
    fireEvent.click(screen.getByRole("button", { name: /connect to another node/i }));
    fireEvent.click(within(canvas).getByText("delay"));
    expect(canvasEdges()).toBe(2);
    expect(screen.queryByText(/has no YES connection/)).not.toBeInTheDocument();
    expect(screen.getByText(/has no NO connection/)).toBeInTheDocument();

    // …and NO on the second, clearing the branch lint.
    fireEvent.click(screen.getByRole("button", { name: /connect to another node/i }));
    fireEvent.click(within(canvas).getByText("send-email"));
    expect(canvasEdges()).toBe(3);
    expect(screen.queryByText(/has no NO connection/)).not.toBeInTheDocument();

    // The side panel lists both branch-labelled links for the selected condition.
    const disconnects = screen.getAllByRole("button", { name: "Disconnect" });
    expect(disconnects).toHaveLength(2);

    // Removing the NO edge from the side panel revives exactly that lint.
    fireEvent.click(disconnects[1]!);
    expect(canvasEdges()).toBe(2);
    expect(screen.getByText(/has no NO connection/)).toBeInTheDocument();

    // The remaining edge is removable straight off the canvas hit-path.
    const hitPath = within(canvas).getByText("Disconnect condition → delay").closest("path");
    expect(hitPath).not.toBeNull();
    fireEvent.click(hitPath!);
    expect(canvasEdges()).toBe(1);
    expect(screen.getByText(/has no YES connection/)).toBeInTheDocument();
  });

  it("saves metadata edits as themselves and definition edits as immutable versions", async () => {
    const row = workflowRow();
    const { stub } = renderApp(<AutomationPage />, { route: "/automation", handlers: graphHandlers(row, definitionOf()) });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    await screen.findByTestId("workflow-canvas");

    // Metadata-only save: name/description ride along, no definition.
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Win back v2" } });
    fireEvent.change(screen.getByLabelText("Workflow description"), { target: { value: "New pitch" } });
    const save = screen.getByRole("button", { name: "Save version" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(stub.calls.put).toHaveBeenCalledWith("/api/v1/workflows/wf-1", {
        name: "Win back v2",
        description: "New pitch",
      }),
    );
    expect(await screen.findByText("Workflow saved")).toBeInTheDocument();

    // A graph edit flips the definition dirty: the full serialized DAG rides along.
    fireEvent.click(screen.getByRole("button", { name: /^wait$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() =>
      expect(stub.calls.put).toHaveBeenCalledWith("/api/v1/workflows/wf-1", {
        definition: {
          nodes: [
            { id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } },
            { id: "delay", kind: "DELAY", config: { minutes: 60 } },
          ],
          edges: [],
        },
      }),
    );
  });

  it("renders an archived workflow read-only with per-node config summaries", async () => {
    const definition: WorkflowDefinitionDto = {
      nodes: [
        { id: "trigger", kind: "TRIGGER", config: { kind: "MANUAL" } },
        { id: "wait", kind: "DELAY", config: { minutes: 60 } },
        { id: "send-email", kind: "SEND_EMAIL", config: { subject: "Come back soon", bodyText: "We miss you" } },
      ],
      edges: [
        { from: "trigger", to: "wait" },
        { from: "wait", to: "send-email" },
      ],
    };
    const row = workflowRow({ status: "ARCHIVED", activeVersionId: "ver-1" });
    const detail: WorkflowDetailResponse = { ...detailOf(row, definition), activeDefinition: definition };
    const handlers: StubHandlers = {
      get: {
        "/api/v1/workflows": () => [row],
        "/api/v1/workflows/wf-1": () => detail,
      },
      getWithMeta: {},
      post: {},
      patch: {},
      put: {},
    };
    renderApp(<AutomationPage />, { route: "/automation", handlers });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    const canvas = await screen.findByTestId("workflow-canvas");

    // Archived ⇒ the whole editor surface is gone; only readable truth stays.
    expect(screen.queryByRole("button", { name: "Save version" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Workflow name")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: /add nodes/i })).not.toBeInTheDocument();

    // Node cards open a plain-language summary of the frozen config.
    fireEvent.click(within(canvas).getByText("wait"));
    expect(screen.getByText("wait 60 min")).toBeInTheDocument();
    fireEvent.click(within(canvas).getByText("send-email"));
    expect(screen.getByText("Come back soon")).toBeInTheDocument();
    fireEvent.click(within(canvas).getByText("trigger"));
    expect(screen.getByText("Runs when you click Run once")).toBeInTheDocument();
  });

  it("drives an ACTIVE workflow's lifecycle actions as body-less POSTs", async () => {
    const row = workflowRow({ status: "ACTIVE", activeVersionId: "ver-1" });
    const detail: WorkflowDetailResponse = { ...detailOf(row), activeDefinition: definitionOf() };
    const handlers: StubHandlers = {
      get: {
        "/api/v1/workflows": () => [row],
        "/api/v1/workflows/wf-1": () => detail,
      },
      getWithMeta: {},
      post: {
        "/api/v1/workflows/wf-1/run": () => ({}),
        "/api/v1/workflows/wf-1/pause": () => ({}),
        "/api/v1/workflows/wf-1/archive": () => ({}),
      },
      patch: {},
      put: {},
    };
    const { stub } = renderApp(<AutomationPage />, { route: "/automation", handlers });

    fireEvent.click(await screen.findByText("Win back quiet customers"));
    await screen.findByTestId("workflow-canvas");

    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/run"));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/pause"));

    // Archive demands a confirmation before the permanent action fires.
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive workflow" }));
    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/workflows/wf-1/archive"));
    expect(await screen.findByText(/Workflow archived/)).toBeInTheDocument();
  });
});
