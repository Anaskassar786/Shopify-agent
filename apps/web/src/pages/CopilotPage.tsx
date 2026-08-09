import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MessageSquareText, Send, Sparkles, Plus } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SkeletonText,
  useToast,
} from "@profit/ui";
import { FactsTable } from "../components/FactsTable";
import { PageHeader } from "../components/PageHeader";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAuth } from "../lib/auth-context";
import { ApiError } from "../lib/api-client";
import { formatRelativeTime } from "../lib/format";
import {
  useAskCopilotMutation,
  useCopilotConversationQuery,
  useCopilotConversationsQuery,
} from "../lib/copilot-queries";
import type {
  CopilotAssistantPayloadDto,
  CopilotEvidenceTableDto,
  CopilotMessageDto,
} from "../lib/api-types";

/**
 * Copilot (M8, ADR 32): the merchant's evidence-backed Q&A surface. Render
 * rule: the assistant's structured payload (tables/bullets/refs) drives the
 * layout — the prose answer is composed from the SAME evidence bundle, so an
 * answer can never disagree with what is drawn.
 */

const SUGGESTED_PROMPTS = [
  "Why are my sales down?",
  "What should I restock?",
  "Forecast next week's revenue",
  "Who is about to churn?",
  "Give me a summary of the business",
] as const;

function EvidenceTable({ table }: { readonly table: CopilotEvidenceTableDto }): ReactNode {
  return <FactsTable table={table} />;
}

function AssistantEvidence({ payload }: { readonly payload: CopilotAssistantPayloadDto }): ReactNode {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium leading-snug text-foreground">{payload.lead}</p>
      {payload.bullets.length > 0 && (
        <ul className="list-inside list-disc space-y-1 text-xs text-muted">
          {payload.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      )}
      {payload.tables.map((table) => (
        <EvidenceTable key={table.title} table={table} />
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Badge tone="neutral">{`method ${payload.method}`}</Badge>
        <Badge tone="neutral">{`confidence ${payload.confidence}/100`}</Badge>
        {payload.modelEnhanced && <Badge tone="ai">polished by Executive agent</Badge>}
        {payload.recommendationRefs.map((ref) => (
          <Link
            key={ref.id}
            to={`/recommendations/${ref.id}`}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {ref.title} →
          </Link>
        ))}
      </div>
      <p className="text-[11px] text-faint">{`Evidence window ${payload.windowLabel}`}</p>
    </div>
  );
}

function MessageBubble({ message }: { readonly message: CopilotMessageDto }): ReactNode {
  if (message.role === "MERCHANT") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-on-primary">
          {message.content}
        </p>
      </div>
    );
  }
  const payload = message.payload as unknown as CopilotAssistantPayloadDto;
  const structured = Array.isArray(payload.tables);
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-subtle bg-surface-raised px-4 py-3">
        {structured ? <AssistantEvidence payload={payload} /> : <p className="whitespace-pre-wrap text-sm text-foreground">{message.content}</p>}
      </div>
    </div>
  );
}

function ThreadPane({ conversationId, onAsked }: { readonly conversationId: string | null; readonly onAsked: (id: string) => void }): ReactNode {
  const conversation = useCopilotConversationQuery(conversationId);
  const ask = useAskCopilotMutation();
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canAsk = hasPermission("copilot:ask");
  const [question, setQuestion] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = endRef.current;
    // jsdom (tests) does not implement scrollIntoView — guard the capability.
    if (target !== null && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [conversation.data?.messages.length, ask.isPending]);

  const askNow = async (prompt: string): Promise<void> => {
    if (!canAsk || ask.isPending) return;
    try {
      const result = await ask.mutateAsync({
        question: prompt,
        ...(conversationId !== null ? { conversationId } : {}),
      });
      setQuestion("");
      onAsked(result.conversationId);
    } catch (error) {
      toast.error("Couldn't ask the copilot", error instanceof ApiError ? error.message : "Try again in a moment.");
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 2) return;
    void askNow(trimmed);
  };

  return (
    <Card className="flex min-h-[28rem] flex-col">
      <CardBody className="flex-1 space-y-3 overflow-y-auto p-4">
        {conversationId === null ? (
          <EmptyState
            icon={<MessageSquareText className="size-6" aria-hidden />}
            title="Ask about your store"
            body="Every answer is computed from your real numbers — sales, forecasts, stock, customers — with the method stamped. Pick a starting question:"
            primaryAction={
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <Button key={prompt} size="sm" variant="secondary" disabled={!canAsk || ask.isPending} onClick={() => void askNow(prompt)}>
                    {prompt}
                  </Button>
                ))}
              </div>
            }
          />
        ) : (
          <QueryBoundary query={conversation} loading={<SkeletonText lines={5} />}>
            {(conversation.data?.messages ?? []).map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {ask.isPending && <p className="text-xs text-muted">Copilot is computing from your data…</p>}
            <div ref={endRef} />
          </QueryBoundary>
        )}
      </CardBody>
      <div className="border-t border-subtle p-3">
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor="copilot-question" className="sr-only">Ask the copilot</label>
          <input
            id="copilot-question"
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={canAsk ? "Ask about sales, stock, customers, forecasts…" : "You have read-only access to copilot"}
            aria-label="Ask the copilot"
            disabled={!canAsk || ask.isPending}
            className="h-9 flex-1 rounded-md border border-subtle bg-surface px-3 text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
          />
          <Button type="submit" size="sm" loading={ask.isPending} disabled={!canAsk || question.trim().length < 2} iconLeft={<Send className="size-3.5" aria-hidden />}>
            Ask
          </Button>
        </form>
      </div>
    </Card>
  );
}

export function CopilotPage(): ReactNode {
  const conversations = useCopilotConversationsQuery();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Land on the newest conversation once the list resolves.
  useEffect(() => {
    if (activeId === null && conversations.data !== undefined && conversations.data.length > 0) {
      setActiveId(conversations.data[0]!.id);
    }
  }, [activeId, conversations.data]);

  return (
    <div className="space-y-4" data-testid="copilot-page">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles className="size-5 text-primary" aria-hidden />
            AI Copilot
          </span>
        }
        subtitle="Ask in plain words — every answer renders from stamped evidence, never invented numbers."
        actions={activeId !== null ? (
          <Button size="sm" variant="secondary" iconLeft={<Plus className="size-3.5" aria-hidden />} onClick={() => setActiveId(null)}>
            New conversation
          </Button>
        ) : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="order-2 lg:order-1">
          <CardHeader title="Conversations" subtitle="Your recent threads" />
          <CardBody className="max-h-[28rem] space-y-1 overflow-y-auto p-2">
            <QueryBoundary query={conversations} compact loading={<SkeletonText lines={3} />}>
              {conversations.data !== undefined && conversations.data.length === 0 ? (
                <p className="p-3 text-xs text-muted">No conversations yet — ask your first question.</p>
              ) : (
                (conversations.data ?? []).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveId(item.id)}
                    aria-current={activeId === item.id}
                    className={`block w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${
                      activeId === item.id ? "bg-primary-soft font-semibold text-foreground" : "text-muted hover:bg-surface-raised"
                    }`}
                  >
                    <span className="line-clamp-2">{item.title}</span>
                    <span className="mt-0.5 block text-[10px] text-faint">{formatRelativeTime(item.lastMessageAt)}</span>
                  </button>
                ))
              )}
            </QueryBoundary>
          </CardBody>
        </Card>
        <div className="order-1 lg:order-2">
          <ThreadPane
            conversationId={activeId}
            onAsked={(id) => setActiveId(id)}
          />
        </div>
      </div>
    </div>
  );
}
