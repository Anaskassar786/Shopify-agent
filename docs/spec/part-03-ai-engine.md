# PROFIT TOOL AI — MASTER PRD
## PART 3: AI Engine

> Status: RECEIVED (2026-08-05)

## PHILOSOPHY
Not a chatbot — a **business decision engine**. Continuously monitors merchant data, detects opportunities, predicts outcomes, explains every recommendation, automates approved actions, measures business impact.

## PIPELINE ARCHITECTURE
Shopify → Sync Engine → PostgreSQL → Analytics Engine → Rule Engine → AI Decision Engine → Recommendation Engine → Explainability Engine → Automation Engine → Merchant.

## AI PROVIDER LAYER
- Never couple business logic with Gemini SDK.
- `AIProvider` port: GeminiProvider now; OpenAI, Claude, local LLM future.
- Provider swap must require almost no business-logic changes.

## AI KNOWLEDGE (continuous)
Store · revenue · orders · products · customers · inventory · discounts · refunds · returns · marketing · growth · profit · risk · CLV.

## AI MEMORY
Customer history · merchant preferences · previous/accepted/rejected recommendations · store performance · seasonality · campaign history.

## RECOMMENDATION ENGINE
Auto-generates recommendations, e.g.: recover abandoned cart, restock, price up/down, launch promotion, target VIPs, thank-you email, upsell, cross-sell, remove dead inventory, predict stockout, prevent refund, increase AOV, increase LTV.

### Every recommendation includes
Title · description · priority · confidence score · business impact · estimated revenue · estimated cost · estimated ROI · risk level · supporting evidence · reasoning · suggested action.

## EXPLAINABLE AI (no black boxes)
Every recommendation explains: why · what data was used · which rules fired · which customers affected · which products affected · expected impact · confidence · alternative options.

## CONFIDENCE SCORE (0–100)
Based on: historical accuracy · merchant behavior · customer behavior · inventory · seasonality · sales trend · data completeness.

## EVIDENCE SNAPSHOTS
Immutable per recommendation: orders analyzed · products analyzed · customer segments · inventory levels · revenue trend · rule execution · AI reasoning · timestamp · approving/rejecting merchant.

## RULE ENGINE (runs BEFORE AI)
Built-in examples: VIP customer, high-value cart, low inventory, dead stock, high return rate, inactive customer, high refund risk, holiday season, Black Friday, Christmas, flash sale, custom merchant rules.
Merchants can: create · disable · enable · prioritize · simulate · test rules.

## DECISION FLOW
Merchant data → Rule Engine → Analytics → Gemini analysis → Recommendation → Explainability → Merchant approval → Automation → Impact measurement.

## INTELLIGENCE DOMAINS
- **Customer segmentation (auto):** VIP, high LTV, returning, one-time buyers, inactive, at-risk, price-sensitive, frequent buyers, coupon users, premium buyers, wholesale, new customers.
- **Product:** best/worst sellers, slow-moving, dead stock, frequently returned, high/low margin, bundle/cross-sell/upsell opportunities.
- **Inventory:** stockout, overstock, slow inventory, warehouse risk, restock time, inventory cost, storage cost, dead inventory.
- **Revenue:** monthly/quarterly revenue, profit, growth, decline, cash-flow risk.
- **Customer:** churn risk, next purchase, LTV, purchase frequency, discount sensitivity, refund probability, email open probability.
- **Cart:** cart value, abandonment probability, recovery probability, discount needed, VIP status, upsell/cross-sell.
- **Marketing:** email campaigns, product promotions, holiday campaigns, flash sales, win-back, referral, VIP campaigns.

## CONTENT GENERATION
- **Email:** personalized (name, products, discount code, tone, CTA, brand style, language support, A/B variants).
- **SMS:** short recovery, VIP alerts, delivery, reminders.
- **Push:** inventory, revenue, customer, campaign, risk alerts.

## AUTOMATION ENGINE
Modes: manual · semi-automatic · fully automatic.
Example flow: abandoned cart → generate discount → generate email → schedule → track result → update analytics.

### Visual workflows
Example: order created → VIP? → premium email + discount → wait 24h → no purchase → reminder → still none → notify merchant.

## JOB QUEUE (BullMQ — confirmed)
Workers: email · SMS · discount · analytics · AI · sync · cleanup · notification.

## SCHEDULER
Immediate · hourly · daily · weekly · monthly · custom cron.

## AI ANALYTICS (track)
Recommendations generated · accepted · rejected · revenue generated · automation success · emails sent · recovery rate · AI accuracy.

## LEARNING SYSTEM / FEEDBACK LOOP
AI improves from accepted/rejected recommendations, revenue impact, automation success, merchant feedback. Approve → store result → future recommendations improve.

## AUDIT TRAIL
Every AI decision stored, never deleted: input · reasoning · rules · merchant · automation · revenue · timestamp.

## FAILSAFE
If AI fails: no automation · notify merchant · store logs · retry safely · **never execute uncertain actions automatically**.

## FUTURE AI FEATURES (design-ready, not v1)
Conversational assistant · voice commands · image analysis · competitor monitoring · pricing optimization · demand forecasting · fraud detection · multi-language AI · merchant copilot · business reports · executive summary.

## SUCCESS CRITERIA
Function like a real business analyst: continuous monitoring, opportunity detection without manual input, explain everything, safe approved automation, learn from feedback, increase measurable outcomes (revenue, conversion, retention, profit).
