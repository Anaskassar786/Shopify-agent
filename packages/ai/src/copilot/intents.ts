import { CopilotIntent } from "@profit/types";

/**
 * Copilot intent classifier (ADR 32, deterministic-first): a CLOSED grammar
 * — the router is a versioned keyword table, never a model. Deterministic
 * routing means the same merchant question always gathers the same evidence
 * and renders the same numbers, with or without an AI provider configured.
 *
 * Ordering IS the disambiguation rule: the first matching row wins, so more
 * specific intents (sales-why-down) sit above their supersets (revenue).
 */

export interface IntentClassification {
  readonly intent: CopilotIntent;
  /** The grammar row that fired — persisted for auditability. */
  readonly matchedPattern: string | null;
}

interface GrammarRow {
  readonly intent: CopilotIntent;
  /** Human label of the row (what we log/persist — not the raw regex). */
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

const GRAMMAR: readonly GrammarRow[] = [
  {
    intent: CopilotIntent.SalesWhyDown,
    label: "sales-decline-explanation",
    patterns: [
      /\bwhy\b.{0,40}\b(sales|revenue|orders?)\b.{0,30}\b(down|drop|fell|fall|declin|low|slow|dip)/i,
      /\b(sales|revenue|orders?)\b.{0,20}\b(down|dropped|fell|falling|declining|dipped|slow)/i,
      /\b(dropped|declined|dip)\b.{0,20}\b(sales|revenue)/i,
    ],
  },
  {
    intent: CopilotIntent.RevenueForecast,
    label: "forward-revenue-projection",
    patterns: [
      /\bforecast/i,
      /\b(predict|projection|projected|expect(?:ed)?)\b.{0,40}\b(sales|revenue|income)/i,
      /\b(sales|revenue)\b.{0,20}\b(next|coming)\b.{0,10}\b(week|month)/i,
      /\bhow much\b.{0,40}\b(will|expect|predict)\b/i,
    ],
  },
  {
    intent: CopilotIntent.RestockWhat,
    label: "replenishment-need",
    patterns: [
      /\brestock/i,
      /\b(replenish|reorder|order more)\b/i,
      /\b(running|run)\s+(low|out)\b/i,
      /\b(out of|low on)\s+stock\b/i,
      /\bstock\s?outs?\b/i,
      /\binventory\b/i,
    ],
  },
  {
    intent: CopilotIntent.ChurnRisks,
    label: "customer-attrition-risk",
    patterns: [
      /\bchurn/i,
      /\b(losing|lost)\s+customers?\b/i,
      /\bcustomers?\b.{0,20}\b(losing|lost)\b/i,
      /\bcustomers?\b.{0,30}\b(leav|laps|inactiv|quiet|at.?risk|churn)/i,
      /\bwin[-\s]?backs?\b.{0,20}\b(candidates?|customers?)\b/i,
      /\bwho\b.{0,20}\b(stop|hasn'?t|haven'?t)\b.{0,20}\b(buy|order|purchase)/i,
    ],
  },
  {
    intent: CopilotIntent.VipCustomers,
    label: "best-customer-segment",
    patterns: [
      /\bvips?\b/i,
      /\b(best|top|most valuable|highest value|loyal)\b.{0,15}\bcustomers?\b/i,
      /\bcustomers?\b.{0,15}\bspend\b.{0,10}\bmost\b/i,
    ],
  },
  {
    intent: CopilotIntent.ProductsDying,
    label: "decaying-products",
    patterns: [
      /\b(dying|dead)\b.{0,10}\b(products?|stock|inventory|skus?)\b/i,
      /\b(products?|items?|skus?)\b.{0,15}\b(dying|dead)\b/i,
      /\b(products?|items?|skus?)\b.{0,25}\b(not|isn'?t|aren'?t|no longer)\b.{0,10}\bsell/i,
      /\b(slow|worst|dead)\b.{0,10}\b(products?|movers?|sellers?|stock)\b/i,
      /\bdead\s?stock\b/i,
    ],
  },
  {
    intent: CopilotIntent.DiscountSuggestion,
    label: "discount-incentive-advice",
    patterns: [
      /\bdiscounts?\b/i,
      /\bcoupons?\b/i,
      /\bpromo(code|tion)?s?\b/i,
      // NB: bare "sale(s)" is revenue vocabulary — only qualified forms here.
      /\b(markdowns?|flash\s?sales?|price\s?drops?|clearance\s?sales?)\b/i,
    ],
  },
  {
    intent: CopilotIntent.BusinessSummary,
    label: "whole-business-overview",
    patterns: [
      /\b(summary|summarize|overview|report|digest)\b/i,
      /\bhow('?s| is)\b.{0,20}\b(store|business|shop|everything)\b/i,
      /\bhow are we doing\b/i,
      /\bbrief me\b/i,
    ],
  },
  {
    intent: CopilotIntent.RevenueSummary,
    label: "recent-revenue-totals",
    patterns: [
      /\b(sales|revenue)\b/i,
      /\bhow much\b.{0,30}\b(make|made|sell|sold|earn)/i,
      /\b(total|gross|net)\b.{0,10}\b(sales|revenue)/i,
      /\border(s| count| volume)?\b.{0,15}\b(this|last|past)\b/i,
    ],
  },
];

/** Classify a merchant question into the closed intent vocabulary. */
export function classifyIntent(question: string): IntentClassification {
  const normalized = question.trim();
  for (const row of GRAMMAR) {
    for (const pattern of row.patterns) {
      if (pattern.test(normalized)) {
        return { intent: row.intent, matchedPattern: row.label };
      }
    }
  }
  return { intent: CopilotIntent.GeneralOther, matchedPattern: null };
}
