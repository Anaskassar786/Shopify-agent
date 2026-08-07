import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExportsPage } from "./ExportsPage";
import { AuditLogsPage } from "./AuditLogsPage";
import { SupportPage } from "./SupportPage";
import { pagedResponse, renderApp, type StubHandlers } from "../test-support/render";
import type { AuditLogRow, ExportRowDto, SupportTicketsResponse, SupportTicketThreadResponse } from "../lib/api-types";

/** M6 system surfaces: exports queue, support tickets, audit export action. */

function exportRow(overrides: Partial<ExportRowDto> = {}): ExportRowDto {
  return {
    id: "exp-1",
    requestedByUserId: "u-1",
    kind: "ORDERS",
    format: "CSV",
    status: "READY",
    params: null,
    fileName: "orders-2026-08.csv",
    rowCount: 1204,
    sizeBytes: 52_232,
    error: null,
    expiresAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-07T09:00:00.000Z",
    createdAt: "2026-08-07T08:55:00.000Z",
    ...overrides,
  };
}

describe("ExportsPage", () => {
  function exportHandlers(rows: ExportRowDto[]): StubHandlers {
    return {
      get: { "/api/v1/exports": () => ({ rows, total: rows.length }) },
      getWithMeta: {},
      post: {},
      patch: {},
      put: {},
      download: { "/api/v1/exports/exp-1/download": () => ({ blob: new Blob(["a,b\n1,2"]), fileName: "orders-2026-08.csv" }) },
    };
  }

  it("renders status truthfully and downloads a READY file through the authenticated client", async () => {
    const objectUrls: string[] = [];
    const createObjectURL = vi.fn(() => "blob:orders");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: (u: string) => void objectUrls.push(u) });
    const clicks: string[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      clicks.push(this.download);
    };
    try {
      const handlers = exportHandlers([exportRow(), exportRow({ id: "exp-2", status: "QUEUED", fileName: null, rowCount: null, sizeBytes: null, expiresAt: null })]);
      renderApp(<ExportsPage />, { route: "/exports", handlers });

      expect(await screen.findByText(/orders-2026-08\.csv/)).toBeInTheDocument();
      expect(screen.getByText("READY")).toBeInTheDocument();
      expect(screen.getByText("QUEUED")).toBeInTheDocument();
      expect(screen.getByText("1204")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /download/i }));
      await waitFor(() => expect(clicks).toContain("orders-2026-08.csv"));
      expect(createObjectURL).toHaveBeenCalled();
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
      vi.unstubAllGlobals();
    }
  });

  it("requests a new export with an optional date range", async () => {
    const handlers: StubHandlers = {
      ...exportHandlers([]),
      post: { "/api/v1/exports": (body: unknown) => exportRow({ kind: "CUSTOMERS", format: "XLSX", id: "exp-3", status: "QUEUED", ...(body as object) }) },
    };
    const { stub } = renderApp(<ExportsPage />, { route: "/exports", handlers });

    fireEvent.click(await screen.findByRole("button", { name: /new export/i }));
    fireEvent.change(screen.getByLabelText("Export data"), { target: { value: "CUSTOMERS" } });
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "XLSX" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue export" }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/exports", { kind: "CUSTOMERS", format: "XLSX" }),
    );
    expect(await screen.findByText("Export queued")).toBeInTheDocument();
  });
});

describe("AuditLogsPage — M6 export action", () => {
  it("queues an AUDIT_LOGS CSV export from the header", async () => {
    const auditRow: AuditLogRow = {
      id: "log-1",
      action: "export.requested",
      entityType: "export",
      entityId: "exp-1",
      result: "SUCCESS",
      userId: "u-1",
      userAgent: null,
      ip: "10.0.0.1",
      metadata: {},
      createdAt: "2026-08-07T09:00:00.000Z",
    };
    const handlers: StubHandlers = {
      get: {},
      getWithMeta: { "/api/v1/audit-logs": () => pagedResponse([auditRow]) },
      post: { "/api/v1/exports": () => exportRow({ kind: "AUDIT_LOGS", status: "QUEUED" }) },
      patch: {},
      put: {},
    };
    const { stub } = renderApp(<AuditLogsPage />, { route: "/audit-logs", handlers });
    fireEvent.click(await screen.findByRole("button", { name: /export audit log/i }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/exports", { kind: "AUDIT_LOGS", format: "CSV" }),
    );
  });
});

describe("SupportPage — M6 tickets workspace", () => {
  const tickets: SupportTicketsResponse = {
    rows: [
      {
        id: "tkt-1",
        openedByUserId: "u-1",
        subject: "Export stopped at 200 rows",
        category: "DATA",
        priority: "NORMAL",
        status: "OPEN",
        messageCount: 1,
        lastMessageAt: "2026-08-06T10:00:00.000Z",
        assignedOperator: null,
        operatorAttention: true,
        resolvedAt: null,
        closedAt: null,
        createdAt: "2026-08-06T10:00:00.000Z",
        updatedAt: "2026-08-06T10:00:00.000Z",
      },
    ],
    total: 1,
  };

  const thread: SupportTicketThreadResponse = {
    ticket: tickets.rows[0]!,
    messages: [
      {
        id: "msg-1",
        authorKind: "MERCHANT",
        authorUserId: "u-1",
        authorOperator: null,
        authorEmail: "ana@example.com",
        body: "The customers export stopped at 200 rows.",
        createdAt: "2026-08-06T10:00:00.000Z",
      },
    ],
  };

  function supportHandlers(): StubHandlers {
    return {
      get: {
        "/api/v1/support/tickets": () => tickets,
        "/api/v1/support/tickets/tkt-1": () => thread,
      },
      getWithMeta: {},
      post: {},
      patch: {},
      put: {},
    };
  }

  it("lists tickets beside the honest FAQ and opens the thread", async () => {
    renderApp(<SupportPage />, { route: "/support", handlers: supportHandlers() });
    expect(await screen.findByText("Your conversations with the team")).toBeInTheDocument();
    expect(screen.getByText("support@profittool.ai")).toBeInTheDocument();

    fireEvent.click(await screen.findByText("Export stopped at 200 rows"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("The customers export stopped at 200 rows.")).toBeInTheDocument();
  });

  it("replies to an open ticket through POST /support/tickets/:id/reply", async () => {
    const handlers: StubHandlers = {
      ...supportHandlers(),
      post: { "/api/v1/support/tickets/tkt-1/reply": () => ({ ticket: tickets.rows[0], message: thread.messages[0] }) },
    };
    const { stub } = renderApp(<SupportPage />, { route: "/support", handlers });

    fireEvent.click(await screen.findByText("Export stopped at 200 rows"));
    fireEvent.change(await screen.findByLabelText("Reply"), { target: { value: "Adding: same for PDF." } });
    fireEvent.click(screen.getByRole("button", { name: /send reply/i }));
    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/support/tickets/tkt-1/reply", { body: "Adding: same for PDF." }),
    );
  });

  it("creates a ticket with category, priority and the opening body", async () => {
    const handlers: StubHandlers = { ...supportHandlers(), post: { "/api/v1/support/tickets": () => tickets.rows[0] } };
    const { stub } = renderApp(<SupportPage />, { route: "/support", handlers });

    fireEvent.click(await screen.findByRole("button", { name: /new ticket/i }));
    fireEvent.change(screen.getByLabelText("Ticket subject"), { target: { value: "PDF pages are blank" } });
    fireEvent.change(screen.getByLabelText("Ticket priority"), { target: { value: "HIGH" } });
    fireEvent.change(screen.getByLabelText("Ticket body"), { target: { value: "Page two shows nothing." } });
    fireEvent.click(screen.getByRole("button", { name: /send to the team/i }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/support/tickets", {
        subject: "PDF pages are blank",
        category: "BUG",
        priority: "HIGH",
        body: "Page two shows nothing.",
      }),
    );
  });

  it("hides the workspace (but keeps FAQs) without support:read", async () => {
    renderApp(<SupportPage />, {
      route: "/support",
      claims: { role: "VIEWER", perms: ["store:read"] },
    });
    expect(await screen.findByText("support@profittool.ai")).toBeInTheDocument();
    expect(screen.queryByText("Your conversations with the team")).not.toBeInTheDocument();
  });
});
