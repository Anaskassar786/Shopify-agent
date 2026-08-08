import type { ProfitDb } from "@profit/db";
import {
  aiCopilotConversations,
  aiCopilotMessages,
  productMetrics,
  shopifyInventoryLevels,
  shopifyLocations,
  shopifyProducts,
  shopifyProductVariants,
  withStoreScope,
} from "@profit/db";
import { createTestDatabase, type TestDatabase } from "@profit/db/testing";
import { CopilotIntent, CopilotMessageRole } from "@profit/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedProvider } from "../test-support/fixtures";
import { bootAiTestDb, seedAnalytics, seedStore } from "../test-support/integration";
import { COPILOT_LEAD_PROMPT } from "./composer";
import { CopilotNotFoundError, CopilotService, type AssistantPayload } from "./service";

let testDb: TestDatabase;
let db: ProfitDb;
let storeA: string;
let storeB: string;

function iso(daysBefore: number): string {
  return new Date(Date.now() - daysBefore * 86_400_000).toISOString().slice(0, 10);
}

/** Inventory plane seed: one fast seller with thin cover → stockout watchlist. */
async function seedInventory(storeId: string, domain: string): Promise<string> {
  const productRows = await db
    .insert(shopifyProducts)
    .values({ storeId, shopifyProductId: `${domain}-p1`, title: "Copper Kettle", status: "ACTIVE" })
    .returning();
  const productId = productRows[0]!.id;
  const locationRows = await db
    .insert(shopifyLocations)
    .values({ storeId, shopifyLocationId: `${domain}-loc`, name: "Main" })
    .returning();
  await db.insert(shopifyProductVariants).values({
    storeId,
    productId,
    shopifyVariantId: `${domain}-v1`,
    inventoryItemId: `${domain}-iem`,
    sku: "CK-1",
  });
  await db.insert(shopifyInventoryLevels).values({
    storeId,
    inventoryItemId: `${domain}-iem`,
    locationId: locationRows[0]!.id,
    available: 8,
  });
  await db.insert(productMetrics).values(
    Array.from({ length: 30 }, (_, i) => ({
      storeId,
      productId,
      metricDate: iso(30 - i),
      unitsSold: 3,
      revenueCents: 12_000,
    })),
  );
  return productId;
}

beforeAll(async () => {
  testDb = await bootAiTestDb();
  db = testDb.db;
  storeA = await seedStore(db, { shopDomain: "copilot-a.myshopify.com", name: "Copilot A" });
  storeB = await seedStore(db, { shopDomain: "copilot-b.myshopify.com", name: "Copilot B" });
  await seedAnalytics(db, storeA, { ordersPerDay: 5, netPerDayCents: 25_000 });
  await seedInventory(storeA, "ca");
}, 120_000);

afterAll(async () => {
  await testDb.close();
});

describe("CopilotService.ask (deterministic path — no provider)", () => {
  it("classifies, answers from real evidence and persists the full trail", async () => {
    const service = new CopilotService({ db, provider: null });
    const result = await service.ask(storeA, null, {
      question: "How much revenue did we make this month?",
    });
    expect(result.intent).toBe(CopilotIntent.RevenueSummary);
    expect(result.modelEnhanced).toBe(false);
    expect(result.aiCalls).toBe(0);
    expect(result.answer).toContain("$7,500.00"); // 30 days × $250.00
    expect(result.answer).toContain("confidence");
    expect(result.evidence.method).toBe("context.v1");

    const detail = await service.getConversation(storeA, result.conversationId);
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0]!.role).toBe(CopilotMessageRole.Merchant);
    expect(detail.messages[0]!.content).toBe("How much revenue did we make this month?");
    const assistant = detail.messages[1]!;
    expect(assistant.role).toBe(CopilotMessageRole.Assistant);
    expect(assistant.intent).toBe(CopilotIntent.RevenueSummary);
    const payload = assistant.payload as unknown as AssistantPayload;
    expect(payload.method).toBe("context.v1");
    expect(payload.confidence).toBeGreaterThan(50);
    expect(payload.modelEnhanced).toBe(false);
    expect(payload.tables.length).toBeGreaterThan(0);
  });

  it("threads follow-ups into the same conversation and bumps last_message_at", async () => {
    const service = new CopilotService({ db, provider: null });
    const first = await service.ask(storeA, null, { question: "Give me a summary of the business" });
    const second = await service.ask(storeA, null, {
      question: "What should I restock?",
      conversationId: first.conversationId,
    });
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.intent).toBe(CopilotIntent.RestockWhat);
    expect(second.answer).toContain("Copper Kettle");
    expect(second.answer).toContain("Cover (days)");

    const detail = await service.getConversation(storeA, first.conversationId);
    expect(detail.messages).toHaveLength(4);
    expect(detail.title).toBe("Give me a summary of the business");

    const conversations = await service.listConversations(storeA);
    expect(conversations.length).toBeGreaterThanOrEqual(2);
    expect(conversations[0]!.id).toBe(first.conversationId); // most recent first
  });

  it("answers stockout + forecast intents from the M8 forecast read model", async () => {
    const service = new CopilotService({ db, provider: null });
    const forecast = await service.ask(storeA, null, { question: "Forecast next week's revenue" });
    expect(forecast.intent).toBe(CopilotIntent.RevenueForecast);
    expect(forecast.evidence.method).toBe("revenue.weekly-seasonality.v1");
    // 30 flat days of $250/day ⇒ the projection reproduces the level.
    expect(forecast.answer).toContain("Expected");
    expect(forecast.answer).toContain("Low");
    expect(forecast.answer).toContain("High");
  });

  it("general questions get the honest capability card", async () => {
    const service = new CopilotService({ db, provider: null });
    const result = await service.ask(storeA, null, { question: "what is the meaning of life?" });
    expect(result.intent).toBe(CopilotIntent.GeneralOther);
    expect(result.answer).toContain("real numbers");
    expect(result.evidence.confidence).toBe(100);
  });

  it("rejects conversations from another tenant (RLS + explicit check)", async () => {
    const service = new CopilotService({ db, provider: null });
    const foreign = await service.ask(storeA, null, { question: "Give me a summary" });
    await expect(service.getConversation(storeB, foreign.conversationId)).rejects.toThrow(CopilotNotFoundError);
    await expect(
      service.ask(storeB, null, { question: "follow up please", conversationId: foreign.conversationId }),
    ).rejects.toThrow(CopilotNotFoundError);
    expect(await service.listConversations(storeB)).toHaveLength(0);
  });

  it("provider-configured asks count exactly one call; absent provider counts none", async () => {
    const provider = new ScriptedProvider([{
      match: (req) => req.promptId === COPILOT_LEAD_PROMPT.promptId,
      output: { lead: "Across {N3} orders in {N1} days: {N2} net for the period." },
    }]);
    const service = new CopilotService({ db, provider });
    const result = await service.ask(storeA, null, { question: "How much revenue did we make?" });
    expect(result.modelEnhanced).toBe(true);
    expect(result.aiCalls).toBe(1);
    expect(result.lead).toContain("$7,500.00");
    const detail = await service.getConversation(storeA, result.conversationId);
    const payload = detail.messages[1]!.payload as unknown as AssistantPayload;
    expect(payload.aiCalls).toBe(1);
    expect(payload.modelEnhanced).toBe(true);
  });
});

describe("copilot tables are RLS-tenant tables (schema contract)", () => {
  it("the scoped role physically cannot see another tenant's copilot rows", async () => {
    const service = new CopilotService({ db, provider: null });
    await service.ask(storeA, null, { question: "Give me a summary of the business" });
    // Inside B's tenant scope the RLS policy filters A's rows at the engine.
    const visible = await withStoreScope(db, storeB, async (tx) => {
      const conversations = await tx
        .select({ id: aiCopilotConversations.id, storeId: aiCopilotConversations.storeId })
        .from(aiCopilotConversations);
      const messages = await tx
        .select({ id: aiCopilotMessages.id, storeId: aiCopilotMessages.storeId })
        .from(aiCopilotMessages);
      return [...conversations, ...messages];
    });
    expect(visible.filter((row) => row.storeId === storeA)).toHaveLength(0);
  });
});
