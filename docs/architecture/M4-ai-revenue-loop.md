# M4 — AI Revenue Loop v1 (as-built)

> Status: ✅ complete. Spec traceability: P3 (recommendation engine), P10 (AI architecture), P12 (services/queues/autonomy) — cross-checked against ROADMAP M4 exit criteria.
> This document describes what was **actually built**, file-by-file. Nothing here is planned, mocked or deferred-within-the-milestone.

---

## 1. What M4 delivers

The full AI revenue loop, end to end, on top of the M2 data plane and the M3 shell:

```
Shopify ──sync (8 modules incl. CHECKOUTS)──▶ PostgreSQL (RLS)
  ─▶ Business Context Builder (pre-aggregated, PII-minimized)
  ─▶ Store Health Score (deterministic, 6 weighted components)
  ─▶ Rule Engine (8 deterministic catalog rules → candidate firings)
  ─▶ 5 AI agents (Gemini, structured JSON only, one call per firing batch)
  ─▶ Server-side calibration (confidence caps, priority floor, risk max)
  ─▶ Recommendation + immutable evidence snapshot (Explainability)
  ─▶ Approval state machine (CAS-guarded transitions)
  ─▶ Automation (MANUAL / SEMI_AUTOMATIC / FULLY_AUTOMATIC) + tools (discount, email)
  ─▶ Attribution v1 (checkout-token → discount-code → customer-window fallback chain)
  ─▶ Learning loop (rejection memory, acceptance-rate calibration, decision feed)
```

**Anti-hallucination is structural, not aspirational:** every number a merchant sees (money, counts, subjects) originates in the deterministic rule catalog, never in model output. The model writes prose, confidence and priority opinions only — and those are re-computed server-side before persistence. Rules fire first; AI ranks and explains; it cannot invent actions or numbers.

---

## 2. Deliverables map (spec → as-built file)

| Spec item | As-built | Notes |
|---|---|---|
| AiProvider port + Gemini adapter | `packages/ai/src/provider/port.ts`, `provider/gemini.ts` | Raw `fetch` transport (`fetchImpl` injectable — tests stub only the network edge), one mandatory repair pass on invalid JSON, time-bounded retries, per-model micro$ pricing table with conservative fallback pricing |
| Business Context Builder | `packages/ai/src/context/builder.ts` | RLS-scoped raw SQL rollups: revenue/trend digest, orders, refunds rate, abandonment, customers (`inactive` = last order 60–180d, `at-risk` 30–60d from `customer_metrics`), inventory pressure. Banned-PII policy enforced in the builder (no emails/names/addresses enter prompts) |
| Store Health | `packages/ai/src/context/health.ts` | 6 weighted components: `revenue_trend`, `refunds`, `inventory_risk`, `abandonment`, `customer_momentum`, `data_coverage` — each with score 0–100 + human reason |
| Rule Engine (built-ins) | `packages/ai/src/rules/catalog.ts` | 8 versioned rules: `cart.abandoned-recovery`, `inventory.stockout-risk`, `inventory.dead-stock`, `customers.vip-appreciation`, `customers.winback-inactive`, `revenue.refund-pressure`, `revenue.decline-review`, `growth.promotion-window`. Every rule carries deterministic estimate constants (revenue/cost/ROI + expectation basis) |
| 5 agents (triage tier) | `packages/ai/src/prompts/registry.ts`, `service/decision.ts` | BusinessAnalyst, CustomerIntelligence, RevenueRecovery, ProductIntelligence, Inventory — prompt packs are versioned code (`promptId@promptVersion`, e.g. `agent.revenue_recovery@v1`), system + context + task + JSON-output contract; run order fixed: RevenueRecovery → Inventory → CustomerIntelligence → BusinessAnalyst → ProductIntelligence |
| Recommendations + evidence + explainability | `packages/ai/src/service/recommendations.ts` (+ `scoring.ts`), `packages/db/src/schema/ai.ts` | Immutable `recommendation_evidence` written once at creation: facts, rule id+version, estimates, `calibration` (model vs final confidence/priority/risk + tier), `contextDigest`, `model{provider,promptId,promptVersion}` |
| Approval state machine | `service/recommendations.ts` | `PENDING_APPROVAL → APPROVED/REJECTED → EXECUTING → EXECUTED/FAILED → MEASURED` (+ `EXPIRED`, `SUPERSEDED`); CAS on `stateVersion`; transition table in code; reject reason feeds the learning loop |
| Tools via registry | `packages/ai/src/tools/{port,discount,email,smtp-sender}.ts` | Typed tool port + allowlisted action types; Discount tool writes Shopify price rules via credentials; Email tool renders templates and sends via SMTP (nodemailer, `SmtpTransportFactory` injectable); no credentials → tool reports itself *unavailable* (typed), never a silent no-op |
| Action execution | `packages/ai/src/service/executor.ts` | `action_executions` rows with unique `idempotencyKey`; RUNNING CAS; per-step checkpoints with tool refs so restarts resume instead of duplicate side-effects; typed `FAILED` with error capture |
| Automation v1 | `decideAutoApproval` (scoring), `packages/ai/src/jobs.ts`, worker `execution.handlers.ts` | Abandoned-cart recovery flow end-to-end; `ADVISORY` actions execute inline (record+notify, no tool); SEMI_AUTOMATIC auto-completes advisories only; FULLY_AUTOMATIC additionally auto-runs discount/email under BOTH caps (`maxDiscountPercent`, `maxAutoApproveEstimatedRevenueCents`), confidence ≥ 80, risk ≠ HIGH |
| Attribution v1 | `packages/ai/src/service/attribution.ts` | 14-day measurement window, sweep batch 200; attribution chain: checkout-token match → discount-code JSONB containment on orders → customer+window fallback; conviction recorded per match; sweep also expires stale `PENDING_APPROVAL` rows |
| Overview / command center read-models | `packages/ai/src/service/overview.ts` | `AiOverviewService` (engine/health/open/outcomes/recent events) + `AutomationOverviewService` (policy, execution ledger, attributed totals) |
| AI surfaces in web | `apps/web/src/pages/{RecommendationsPage,RecommendationDetailPage,AiCommandCenterPage,AutomationPage, ai-shared}.tsx` + dashboard `AiInsightsCard` | Decision queue with tabs/filters + approve/reject dialogs; detail page with evidence, calibration, timeline, executions; command center with engine status, health gauge + components, pipeline, learning loop, decision feed; automation policy editor (dirty-gated PATCH) + guardrails + ledger |

### API (as-built routes)

| Route | Permission | Behavior |
|---|---|---|
| `GET /api/v1/recommendations` | `recommendations:read` | Paged, filterable (`status`, `priority`, `type`), zod-strict query schema |
| `GET /api/v1/recommendations/:id` | `recommendations:read` | Row + immutable evidence + full event timeline + executions |
| `POST /api/v1/recommendations/:id/approve` | `recommendations:approve` | CAS transition; enqueues execution when mode requires a tool (advisories complete inline) |
| `POST /api/v1/recommendations/:id/reject` | `recommendations:reject` | Optional reason (≤500 chars) → learning loop (`dedupe` 30-day reject memory at creation time) |
| `POST /api/v1/recommendations/run` | `recommendations:approve` | Manual analysis; 202 + jobId `ai:manual:{store}:{minute}` (idempotent debounce) |
| `GET /api/v1/ai/overview` | `recommendations:read` | Command center read-model |
| `GET /api/v1/automation/overview` | `automation:read` | Policy + ledger + attributed outcomes |
| `PATCH /api/v1/store/settings` | `settings:update` | Extended with `automationPreferences` (nested merge, `.strict()` zod; mode enum, abandoned-cart block, autopilot caps) |

### Worker (as-built jobs)

| Job | Queue | Trigger |
|---|---|---|
| `ai.run` | `ai` | Manual (API) or scheduled tick (`everyMs = AI_RUN_INTERVAL_MS`, min 1h, default 6h) |
| `ai.run.nightly-tick` | `ai` | Per-store fan-out, 6h bucket |
| `ai.measure.tick` | `analytics` | Attribution sweep every `AI_MEASURE_INTERVAL_MS` (min 1h, default 24h) |
| `ai.execute.email-action` | `email` | Enqueued on approve/auto-approve with `aiexec:` idempotent job ids |
| `ai.execute.discount-action` | `discount` | Same |

Handler behavior: run completes → `RecommendationCreated` realtime events per new recommendation + worker audit `ai.run.completed` (RESULT `SUCCESS` unless run status `FAILED`); execution failure on final attempt → execution `FAILED`, recommendation `FAILED`, merchant notification, `ai.action.failed` audit.

---

## 3. Anti-hallucination design (the milestone's core decision)

P10 mandates "structured JSON only" + Zod + DB cross-check. M4 goes further — the categories of things a model can be wrong about are *removed from its blast radius*:

1. **Numbers come from rules, not the model.** Money amounts, counts, ROI, and action subjects are computed by the deterministic rule catalog and context builder. Model output is `reasoning[] + confidence + priority + risk` only; schema has no money fields.
2. **Unknown subject references are dropped, not trusted.** The model may echo `firingRef`s; any ref not produced by the deterministic firing set is discarded server-side (hallucinated actions literally cannot attach to a recommendation).
3. **Confidence is calibrated server-side** (`scoring.ts`): orders < 10 → cap 55; customers < 5 → cap 65; tiers (90+ / 70–90 / <70) derived from the calibrated value; after ≥5 decisions the acceptance-rate learning adjuster multiplies in (`0.8 + acceptanceRate/500`, bounded).
4. **Priority has a floor and a ceiling.** The rule's base priority is the floor; the model may raise it by at most one rank; `CRITICAL` only if the rule itself is `CRITICAL`.
5. **Risk never improves through the model.** `finalRisk = max(modelRisk, ruleRisk)`.
6. **Evidence is written once, at creation** and never mutated (explainability + audit trail: "captured once, at creation" is literally rendered on the detail page).

### Failsafe (provider down must mean *nothing happens*, not *something silently happens*)

- `AiRunStatus = COMPLETED | PROVIDER_UNAVAILABLE | FAILED` — there is **no PARTIAL**. Agent-level errors degrade gracefully (run still completes with `errorMessage = "{agentId}: {kind}"` and a FAILED `ai_call_logs` row); provider unavailability/rate-limit aborts the run explicitly.
- Provider-unavailable notification policy: manual trigger → "AI provider not configured" (direct notify); scheduled trigger → dedupes by checking last `PROVIDER_UNAVAILABLE` runs in 24h ("AI analysis is paused"). Zero automation is scheduled from an aborted run.
- Cost circuit breaker: `AI_MAX_AGENT_CALLS_PER_RUN` (default 5, max 10) hard-stops paid calls; remaining agents are skipped and the run completes with what was safely gathered. Only *succeeded* calls count.
- Every paid call is logged in `ai_call_logs` (request digest sha256, model, tokens, micro$ cost, latency, status) — the metering feed for M5 entitlements.

---

## 4. Schema changes (migration `0005_m4_ai_engine.sql`)

8 new tables (all with `store_id` + RLS policies appended; tenant backstop consistent with M2):

| Table | Purpose |
|---|---|
| `shopify_checkouts` | Abandoned-checkout feed (8th sync module); `orders.checkout_token` + `orders.discount_codes` (JSONB) added for attribution joins |
| `recommendations` | The decision queue; partial unique index on open-fingerprint dedupe |
| `recommendation_evidence` | 1:1 immutable snapshot at creation |
| `recommendation_events` | Append-only timeline (audit never deletes) |
| `action_executions` | Tool runs; unique `idempotency_key`; per-step checkpoints |
| `recommendation_outcomes` | Attribution results (attributed revenue/orders, conviction, window) |
| `ai_runs` | Completed-run record (no "live" partial rows — live state is `background_jobs`) |
| `ai_call_logs` | Per-call forensics + cost metering |

15 new pgEnums (run/agent/action/status/priority/risk/trigger/event/conviction/… — all in `packages/types`, no magic strings).

**8th sync module: CHECKOUTS.** `packages/sync` gained the checkouts module (`restCheckoutSchema` DTO, `upsertCheckouts` writer, checkpointed module, `checkouts/create|update` webhook appliers → **20 business topics**), the `checkouts:sync` permission (29 codes), seed updated. Full syncs now fan out 8 module groups.

> **Real defect found by the M4 integration tests (now fixed):** `packages/sync/src/jobs.ts` job-schema zod enum did not include `SyncModule.Checkouts`, so the 8th module could never be enqueued and full-sync fan-in (expecting 8 children) would never complete. Caught by worker integration tests, fixed in the schema.

---

## 5. Amendments to the plan (announced rule-6 deviations, recorded here permanently)

1. **`packages/ai` is the AI home**, not `apps/api/src/ai` (ARCHITECTURE §4.4 updated). Reason: the worker composes the decision engine as heavily as the API reads its outputs; a package keeps both consumers dependency-clean and matches M2's `packages/sync` precedent for shared engines.
2. **Gemini via raw `fetch`**, not `@google/genai`: the provider needs JSON-mode + repair semantics + precise token micro-costing that are clearer over the documented REST surface; transport is injectable (`fetchImpl`) exactly like the test doubles pattern. The provider SDK invariant (I1) still holds — business logic sees only the `AiProvider` port.
3. **Prompt registry is versioned code** (`promptId@vN`), not db-backed `ai_prompts` yet: P10 demands prompt version control + per-call version logging — code versioning satisfies it with Git as the audit trail; db-backed packs land when A/B prompts exist (M6 campaigns).
4. **`ai_runs` written at completion only** (final + summary), live run progress is read from the durable `background_jobs` mirror (no half-written run rows; one write path).
5. **`ADVISORY` is a first-class action type**: record + notify, executes inline to `EXECUTED` at approval, no tool — restock notes and reviews auto-complete under SEMI_AUTOMATIC.
6. **Automation settings ride the existing `PATCH /store/settings`** envelope (`automationPreferences`, nested merge) instead of a parallel endpoint — one write path for merchant-controlled behavior, one zod schema family, one audit trail.
7. **Attribution fallback chain ordered by conviction**: checkout-token (exact) → discount-code containment (`orders.discount_codes @> [{"code":...}]`) → customer+window (weakest, labeled as such via conviction). All attributed figures surfaced with methodology in UI copy.

---

## 6. Learning loop & measurement (closed, not decorative)

- **Rejection memory:** reject dedupe shares the open-fingerprint check for 30 days (`fingerprint = sha256(storeId | ruleId | v{ruleVersion} | subjectKey)` scanned across open statuses + recent rejects) — rejected ideas are not re-offered weekly.
- **Acceptance-rate calibration:** after ≥5 decided recommendations, the engine's acceptance rate adjusts future confidence (bounded multiplier) — the engine literally gets more/less confident as the merchant's decisions accumulate.
- **Attribution outcomes** (`recommendation_outcomes`) roll up into the command center "Recovered by actions" + automation "Attributed outcomes" tiles — modeled estimates are labeled (conviction + expectation basis string).
- **Decision feed** (`recommendation_events` latest) shows actor-typed history end-to-end.

## 7. Failsafe / tenant / data-privacy posture

- PII minimization in prompts is enforced in the builder (no customer names/emails/addresses); digests are hashed for logging.
- All M4 tables carry RLS policies in the same migration; every service query path either runs inside `withStoreScope` (RLS-scoped) or was integration-tested for tenant isolation.
- AI cannot delete products, change prices, send messages without permission, or spend money (P10 hard limits): no such tool exists in the registry, and FULLY_AUTOMATIC additionally requires confidence ≥ 80 and risk ≠ HIGH.

## 8. Verification evidence (all gates)

| Gate | Result |
|---|---|
| Typecheck (`pnpm -r run typecheck`) | 0 errors across 14 projects |
| Tests (`pnpm -r run test`) | 597 passed + 4 self-skipped (redis-driver tests require a live Redis), 21 files in web, 21 in api, 12 in ai, 7 in worker |
| Coverage — `packages/ai` | 95.09 stmt / 78.31 branch / 93.68 func / 95.09 line |
| Coverage — `apps/api` | 92.56 / 75.63 / 93.70 / 92.56 |
| Coverage — `apps/worker` | 93.08 / 78.70 / 93.93 / 93.08 |
| Coverage — `apps/web` | 91.23 / 83.91 / 81.54 / 91.23 |
| Coverage — `packages/sync` | 100 / 100 / 100 / 100 |
| Build (`pnpm -r run build`) | web vite chunks ✓ · api esbuild ✓ · worker esbuild ✓ |
| Migration drift (`@profit/db run generate`) | "No schema changes, nothing to migrate" — 0005 matches schema exactly |

M4 adds 336 tests over the M3 baseline of 465 → **597 workspace tests** (`packages/ai` 101, `apps/api` 163, `apps/worker` 34, `apps/web` 138, `packages/sync` 21 + enacted enum/contract suites).

## 9. Deliberately deferred (tracked in RISKS, not silently missing)

- Conversational copilot chat over the tool registry → M8+ (P3 phase 3).
- SMS/WhatsApp channels → M6 campaign centers (ports exist — Email tool is live, SMS queue exists).
- Workflow DAG engine / visual builder → M6 (the M4 execution model is single-action with durable steps; the DAG generalizes it).
- Full Email Center (templates UI, tracking pixel, unsubscribe pages) → M6; M4 ships the send path + SMTP adapter.
- Dashboard profit card → M6 pending COGS source decision (RISKS #6c; M4 delivered AI score + AI insights + automation outcomes tiles).
- Checkouts browse UI surface — the feed exists for AI + attribution; a merchant-facing list is M6 analytics polish.
