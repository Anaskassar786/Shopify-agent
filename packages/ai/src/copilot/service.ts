import { and, asc, desc, eq, type ProfitDb } from "@profit/db";
import {
  aiCopilotConversations,
  aiCopilotMessages,
  withStoreScope,
} from "@profit/db";
import { ForecastService } from "@profit/forecasting";
import {
  CopilotMessageRole,
  type CopilotIntent as CopilotIntentValue,
} from "@profit/types";
import type { AiProvider } from "../provider/port";
import { composeAnswer } from "./composer";
import { gatherEvidence, type CopilotEvidence, type EvidenceTable, type RecommendationRef } from "./evidence";
import { classifyIntent } from "./intents";

/**
 * Copilot service (ADR 32/35): orchestration + persistence for the merchant
 * Q&A plane. The full evidence bundle lands in the assistant message payload
 * — the merchant-visible audit trail — so any answer can be re-derived from
 * what was actually stored. All reads/writes are RLS-scoped per tenant.
 */

export interface AssistantPayload {
  readonly headline: string;
  readonly lead: string;
  readonly bullets: readonly string[];
  readonly tables: readonly EvidenceTable[];
  readonly recommendationRefs: readonly RecommendationRef[];
  readonly method: string;
  readonly confidence: number;
  readonly matchedPattern: string | null;
  readonly windowLabel: string;
  readonly modelEnhanced: boolean;
  readonly aiCalls: number;
  readonly costMicros: number;
}

export interface CopilotAskInput {
  readonly question: string;
  readonly conversationId?: string;
}

export interface CopilotAskResult {
  readonly conversationId: string;
  readonly messageId: string;
  readonly intent: CopilotIntentValue;
  readonly answer: string;
  readonly lead: string;
  readonly modelEnhanced: boolean;
  readonly evidence: CopilotEvidence;
  readonly aiCalls: number;
}

export interface ConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly lastMessageAt: string;
  readonly createdAt: string;
}

export interface ConversationMessageDto {
  readonly id: string;
  readonly role: (typeof CopilotMessageRole)[keyof typeof CopilotMessageRole];
  readonly intent: string | null;
  readonly content: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ConversationDetail {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ConversationMessageDto[];
}

export class CopilotNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotNotFoundError";
  }
}

export interface CopilotServiceDeps {
  readonly db: ProfitDb;
  readonly provider: AiProvider | null;
  readonly forecastService?: ForecastService;
}

const MAX_CONVERSATION_LIST = 20;
const MAX_MESSAGES = 100;

function payloadOf(evidence: CopilotEvidence, answer: { lead: string; modelEnhanced: boolean; aiCalls: number; costMicros: number }): AssistantPayload {
  return {
    headline: evidence.headline,
    lead: answer.lead,
    bullets: evidence.bullets,
    tables: evidence.tables,
    recommendationRefs: evidence.recommendationRefs,
    method: evidence.method,
    confidence: evidence.confidence,
    matchedPattern: evidence.matchedPattern,
    windowLabel: evidence.windowLabel,
    modelEnhanced: answer.modelEnhanced,
    aiCalls: answer.aiCalls,
    costMicros: answer.costMicros,
  };
}

export class CopilotService {
  private readonly db: ProfitDb;
  private readonly provider: AiProvider | null;
  private readonly forecastService: ForecastService | undefined;

  constructor(deps: CopilotServiceDeps) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.forecastService = deps.forecastService;
  }

  async ask(storeId: string, userId: string | null, input: CopilotAskInput): Promise<CopilotAskResult> {
    const question = input.question.trim();
    const now = new Date();
    const classification = classifyIntent(question);
    const evidence = await gatherEvidence(
      this.db,
      storeId,
      classification,
      now,
      this.forecastService ?? new ForecastService(this.db),
    );
    const composed = await composeAnswer(this.provider, question, evidence);

    return withStoreScope(this.db, storeId, async (tx) => {
      let conversationId = input.conversationId;
      if (conversationId !== undefined) {
        const existing = await tx
          .select({ id: aiCopilotConversations.id })
          .from(aiCopilotConversations)
          .where(
            and(
              eq(aiCopilotConversations.id, conversationId),
              eq(aiCopilotConversations.storeId, storeId),
            ),
          )
          .limit(1);
        if (existing[0] === undefined) {
          throw new CopilotNotFoundError(`conversation ${conversationId} not found`);
        }
        await tx
          .update(aiCopilotConversations)
          .set({ lastMessageAt: now, updatedAt: now })
          .where(eq(aiCopilotConversations.id, conversationId));
      } else {
        const created = await tx
          .insert(aiCopilotConversations)
          .values({
            storeId,
            openedByUserId: userId,
            title: question.slice(0, 160),
            lastMessageAt: now,
          })
          .returning({ id: aiCopilotConversations.id });
        conversationId = created[0]?.id;
        if (conversationId === undefined) throw new Error("conversation insert returned no id");
      }

      await tx.insert(aiCopilotMessages).values({
        storeId,
        conversationId,
        role: CopilotMessageRole.Merchant,
        content: question,
      });
      const assistantRows = await tx
        .insert(aiCopilotMessages)
        .values({
          storeId,
          conversationId,
          role: CopilotMessageRole.Assistant,
          intent: classification.intent,
          content: composed.text,
          payload: payloadOf(evidence, composed) as unknown as Record<string, unknown>,
        })
        .returning({ id: aiCopilotMessages.id });
      const messageId = assistantRows[0]?.id;
      if (messageId === undefined) throw new Error("copilot message insert returned no id");

      return {
        conversationId,
        messageId,
        intent: classification.intent,
        answer: composed.text,
        lead: composed.lead,
        modelEnhanced: composed.modelEnhanced,
        evidence,
        aiCalls: composed.aiCalls,
      };
    });
  }

  async listConversations(storeId: string, limit = MAX_CONVERSATION_LIST): Promise<ConversationListItem[]> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const rows = await tx
        .select({
          id: aiCopilotConversations.id,
          title: aiCopilotConversations.title,
          lastMessageAt: aiCopilotConversations.lastMessageAt,
          createdAt: aiCopilotConversations.createdAt,
        })
        .from(aiCopilotConversations)
        .where(eq(aiCopilotConversations.storeId, storeId))
        .orderBy(desc(aiCopilotConversations.lastMessageAt))
        .limit(Math.min(limit, MAX_CONVERSATION_LIST));
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        lastMessageAt: row.lastMessageAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  async getConversation(storeId: string, conversationId: string): Promise<ConversationDetail> {
    return withStoreScope(this.db, storeId, async (tx) => {
      const conversation = await tx
        .select({
          id: aiCopilotConversations.id,
          title: aiCopilotConversations.title,
        })
        .from(aiCopilotConversations)
        .where(
          and(
            eq(aiCopilotConversations.id, conversationId),
            eq(aiCopilotConversations.storeId, storeId),
          ),
        )
        .limit(1);
      const row = conversation[0];
      if (row === undefined) throw new CopilotNotFoundError(`conversation ${conversationId} not found`);
      const messages = await tx
        .select({
          id: aiCopilotMessages.id,
          role: aiCopilotMessages.role,
          intent: aiCopilotMessages.intent,
          content: aiCopilotMessages.content,
          payload: aiCopilotMessages.payload,
          createdAt: aiCopilotMessages.createdAt,
        })
        .from(aiCopilotMessages)
        .where(eq(aiCopilotMessages.conversationId, conversationId))
        .orderBy(asc(aiCopilotMessages.createdAt))
        .limit(MAX_MESSAGES);
      return {
        id: row.id,
        title: row.title,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          intent: message.intent,
          content: message.content,
          payload: message.payload as Record<string, unknown>,
          createdAt: message.createdAt.toISOString(),
        })),
      };
    });
  }
}
