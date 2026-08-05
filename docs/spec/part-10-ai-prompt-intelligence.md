# PROFIT TOOL AI — MASTER PRD
## PART 10: AI Prompt Engineering, Architecture & Intelligence System

> Status: RECEIVED (2026-08-05)

## OBJECTIVE
Reliable AI decision engine — a business intelligence layer, not a text generator: analyze store data, find opportunities, explain decisions, recommend actions, predict outcomes, trigger automation safely.

## SYSTEM FLOW
Shopify data → Data Processing Layer → Business Context Builder → AI Reasoning Engine → Recommendation Generator → Rule Validation → Merchant Approval → Automation Execution.

## MODEL LAYER
Primary: Gemini. Future: OpenAI, Claude, open-source. AI Provider Interface + adapters; never hardcode one provider.

## SPECIALIZED AI AGENTS (not one general AI)
1. **Business Analyst Agent** — store health: input revenue/orders/customers/products/inventory/marketing → output store health score, growth opportunities, risk areas.
2. **Customer Intelligence Agent** — purchase history, LTV, frequency, recency, cart behavior → VIPs, churn risk, segment suggestions.
3. **Revenue Recovery Agent** — abandoned carts, failed payments, inactive customers → email/discount/reminder/personal-offer actions.
4. **Product Intelligence Agent** — sales velocity, margin, inventory, reviews, trends → upsell, cross-sell, bundle, remove recommendations.
5. **Inventory Agent** — stockout risk, dead inventory, restock requirements.

## PROMPT ARCHITECTURE (every request)
- **System prompt:** AI role, rules, limitations, output format, safety rules.
- **Business context:** store profile (name, revenue, customers, top product, inventory, etc.).
- **Task:** e.g., "Find top 5 revenue opportunities."
- **Output format:** structured JSON only — never free text only.

## AI RESPONSE SCHEMA (example shape)
recommendation · confidence · priority (HIGH/…) · estimated_revenue · reasoning[] · action {type, status: PENDING_APPROVAL}.

## EXPLAINABLE AI (stored per decision)
Evidence: data points used · rules triggered · calculations · timestamp · **AI model version** · **prompt version**.

## CONFIDENCE TIERS
90–100 high · 70–90 medium · <70 needs review.

## AI SAFETY RULES (hard prohibitions)
AI cannot: delete products · change prices automatically · send campaigns without permission · spend money · modify store settings without merchant approval.

## HUMAN APPROVAL FLOW
AI suggests → merchant reviews → approve/reject → execute → measure result.

## MEMORY SYSTEM
Store preferences · merchant goals · past decisions · successful campaigns · failed recommendations. Example learning: merchant rejected discounts 5× → prefer email campaigns before discounts.

## PROMPT VERSION CONTROL
Prompt ID · version · created date · changes · performance (e.g., `customer_agent_prompt_v3`).

## AI EVALUATION (measure)
Recommendation accuracy · merchant approval rate · revenue generated · automation success · false recommendations.

## FEEDBACK LOOP
Recommendation → merchant action → revenue result → feedback → improve AI.

## COST OPTIMIZATION
Don't call AI unnecessarily: caching · batch processing · scheduled analysis · small models for simple tasks · large models for complex decisions.

## AI JOB QUEUE
Example midnight analysis: analyze all customers → generate insights → save recommendations → notify merchant.

## REAL-TIME AI EVENTS (triggers)
New order · customer created · cart abandoned · inventory changed · product added · refund created.

## GUARDRAILS
Prevent: hallucinated numbers · wrong customer info · invalid discounts · unsupported claims.

## DATA PRIVACY
AI receives only required data; never send passwords, payment info, sensitive credentials.

## AI LOGGING (per call)
Request · response · model · token usage · cost · latency · errors.

## FUTURE
Voice AI · daily AI business briefing ("revenue dropped 8% because…") · autonomous goal mode (merchant sets "increase revenue 20%", AI creates strategy).

## FINAL GOAL
Trusted AI business partner: understand the store, explain opportunities, recommend actions, safely automate growth.
