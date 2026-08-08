import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CopilotPage } from "./CopilotPage";
import { renderApp, type StubHandlers } from "../test-support/render";
import type {
  CopilotAskResponseDto,
  CopilotConversationDetailDto,
  CopilotConversationListItemDto,
} from "../lib/api-types";

/** M8 copilot surface (ADR 32): threads render FROM the evidence payload. */

const EVIDENCE = {
  intent: "SALES_WHY_DOWN",
  matchedPattern: "sales.why_down",
  headline: "Net revenue fell 18% vs the prior 30 days",
  bullets: ["2 high-velocity products stocked out mid-window"],
  tables: [
    {
      title: "Top declining products",
      columns: ["Product", "Revenue Δ"],
      rows: [["Brass Ladle", "-21%"]],
    },
  ],
  recommendationRefs: [],
  method: "business-context.30d.v1",
  confidence: 82,
  currency: "USD",
  windowLabel: "last 30 days",
} as const;

function conversationItem(): CopilotConversationListItemDto {
  return {
    id: "conv-1",
    title: "Sales dip question",
    lastMessageAt: "2026-08-08T09:00:00.000Z",
    createdAt: "2026-08-08T08:55:00.000Z",
  };
}

function conversationDetail(): CopilotConversationDetailDto {
  return {
    id: "conv-1",
    title: "Why are my sales down?",
    messages: [
      {
        id: "m-1",
        role: "MERCHANT",
        intent: null,
        content: "Why are my sales down?",
        payload: {},
        createdAt: "2026-08-08T09:00:00.000Z",
      },
      {
        id: "m-2",
        role: "ASSISTANT",
        intent: "SALES_WHY_DOWN",
        content: "Net revenue fell 18% vs the prior 30 days.",
        payload: {
          headline: EVIDENCE.headline,
          lead: EVIDENCE.headline,
          bullets: EVIDENCE.bullets,
          tables: EVIDENCE.tables,
          recommendationRefs: [],
          method: EVIDENCE.method,
          confidence: EVIDENCE.confidence,
          modelEnhanced: false,
          windowLabel: EVIDENCE.windowLabel,
        },
        createdAt: "2026-08-08T09:00:04.000Z",
      },
    ],
  };
}

function askResponse(): CopilotAskResponseDto {
  return {
    conversationId: "conv-1",
    messageId: "m-2",
    intent: "SALES_WHY_DOWN",
    answer: "Net revenue fell 18% vs the prior 30 days.",
    modelEnhanced: false,
    evidence: EVIDENCE,
  };
}

function handlers(overrides: Partial<StubHandlers["get"]> = {}): StubHandlers {
  return {
    get: {
      "/api/v1/copilot/conversations": () => [conversationItem()],
      "/api/v1/copilot/conversations/conv-1": () => conversationDetail(),
      ...overrides,
    },
    getWithMeta: {},
    post: { "/api/v1/copilot/ask": () => askResponse() },
    patch: {},
    put: {},
    download: {},
  };
}

describe("CopilotPage", () => {
  it("auto-opens the newest conversation and renders the assistant answer FROM its evidence payload", async () => {
    renderApp(<CopilotPage />, { route: "/copilot", handlers: handlers() });

    // Merchant bubble + evidence-structured assistant bubble.
    expect(await screen.findByText("Why are my sales down?")).toBeInTheDocument();
    expect(await screen.findByText("Net revenue fell 18% vs the prior 30 days")).toBeInTheDocument();
    expect(screen.getByText("2 high-velocity products stocked out mid-window")).toBeInTheDocument();
    // Evidence table renders with header + row.
    expect(screen.getByRole("table", { name: "Top declining products" })).toBeInTheDocument();
    expect(screen.getByText("Brass Ladle")).toBeInTheDocument();
    // Method + confidence are stamped on the answer.
    expect(screen.getByText("method business-context.30d.v1")).toBeInTheDocument();
    expect(screen.getByText("confidence 82/100")).toBeInTheDocument();
    expect(screen.getByText("Evidence window last 30 days")).toBeInTheDocument();
  });

  it("shows suggested prompts on a fresh page and asking posts the question then opens the thread", async () => {
    const { stub } = renderApp(<CopilotPage />, {
      route: "/copilot",
      handlers: handlers({ "/api/v1/copilot/conversations": () => [] }),
    });

    // Empty thread picker + suggested starting question.
    expect(await screen.findByText("Ask about your store")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why are my sales down?" }));

    await waitFor(() => expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/copilot/ask", { question: "Why are my sales down?" }));
    // Thread opens on the returned conversation id and the evidence bubble lands.
    expect(await screen.findByText("Net revenue fell 18% vs the prior 30 days")).toBeInTheDocument();
  });

  it("sends the typed question with the active conversation id", async () => {
    const { stub } = renderApp(<CopilotPage />, { route: "/copilot", handlers: handlers() });
    expect(await screen.findByText("Net revenue fell 18% vs the prior 30 days")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Ask the copilot"), { target: { value: "Who is about to churn?" } });
    fireEvent.click(screen.getByRole("button", { name: /^ask$/i }));

    await waitFor(() =>
      expect(stub.calls.post).toHaveBeenCalledWith("/api/v1/copilot/ask", {
        question: "Who is about to churn?",
        conversationId: "conv-1",
      }),
    );
  });

  it("read-only roles (copilot:read without copilot:ask) cannot ask", async () => {
    renderApp(<CopilotPage />, {
      route: "/copilot",
      handlers: handlers({ "/api/v1/copilot/conversations": () => [] }),
      claims: { perms: ["copilot:read"] },
    });

    expect(await screen.findByText("Ask about your store")).toBeInTheDocument();
    const input = screen.getByLabelText("Ask the copilot");
    expect(input).toBeDisabled();
    const askButton = screen.getByRole("button", { name: /^ask$/i });
    expect(askButton).toBeDisabled();
    const suggested = screen.getByRole("button", { name: "What should I restock?" });
    expect(suggested).toBeDisabled();
  });
});
