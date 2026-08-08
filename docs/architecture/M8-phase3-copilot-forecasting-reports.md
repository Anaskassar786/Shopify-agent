# M8 — Phase 3: AI Copilot · Multi-Agent Expansion · Advanced Forecasting · Enterprise Reporting

The "talk to your store" milestone: a merchant asks in plain language and
gets an answer that is **computed, never invented**; the platform projects
revenue/demand/stockouts/churn with fully declared methods; and closed-period
enterprise reports assemble, summarize, file themselves as PDFs and deliver
themselves by email. Scope = spec part-08 Phase 3 exactly
(`docs/spec/part-08-future-roadmap-agents-enterprise.md`); Phase 4/5 items on
the old M8+ roadmap row (public API/OpenAPI, white label, mobile) are
honestly re-scoped to M9+ (see §7).

## 1. What this milestone delivers

- **AI Copilot** — `/copilot` chat surface + `POST /api/v1/copilot/ask` +
  conversation history. A closed 10-intent grammar classifies the question;
  a typed evidence pack is built deterministically; the answer renders FROM
  that pack — headline, bullets, tables, method stamp, confidence and
  recommendation references all derive from one structure, so the prose can
  never disagree with the drawn numbers (ADR 32).
- **Advanced forecasting** (`packages/forecasting`, ADR 33) — deterministic
  method-versioned projections: revenue (weekly-seasonality, 56d window),
  per-variant demand (14d/30d velocity blend), stockout days-of-cover, and
  RFM churn risks. Served at `GET /api/v1/analytics/forecasts?horizonDays=`
  (7|14|30) and consumed by the copilot and the report engine.
- **Enterprise reports** (`packages/reporting`, ADR 34) — DAILY/WEEKLY/
  MONTHLY/QUARTERLY closed-period reports: KPI cards with prior-period
  deltas, highlights, performance + top-product tables, the forecast strip,
  AI-action counters, and an EXECUTIVE-agent summary; filed as paginated
  PDFs in Postgres (the M6 bytea precedent), downloadable from `/reports`,
  emailable, scheduled per store by the worker tick.
- **Multi-agent expansion** (ADR 36) — two new agents: EXECUTIVE (prose
  only, deliberately outside the decision run-order) and PRICING (extends
  the run-order with a margin-checked price-uplift rule — the 9th rule).
- **RBAC + schema** (ADR 35) — permissions `copilot:read`, `copilot:ask`,
  `reports:read`, `reports:manage` seeded idempotently into the M1 matrix;
  migration `0008` adds `ai_copilot_conversations`, `ai_copilot_messages`,
  `reports` (RLS DO-block + `profit_app` grants appended per convention),
  `store_settings.report_preferences` jsonb, enum extensions
  (`ai_agent_id` +PRICING/+EXECUTIVE, `recommendation_type` +'ADJUST_PRICE').

## 2. Architecture

### Copilot (`packages/ai/src/copilot`, ADR 32)

Pipeline: `classifyIntent` (ordered closed grammar — regex catalog over
normalized text, first match wins, `GENERAL_OTHER` otherwise; the matched
pattern id is recorded on the message for audit) → `buildEvidence` (one
builder per intent over `buildBusinessContext` (M4), `ForecastService`
(M8) and open recommendations; every pack carries `method`, `confidence`,
`windowLabel`, `currency`) → `renderAnswer` (markdown composed from the
pack — deterministic numbers only) → optional **Executive lead rephrase**.

The rephrase crosses the provider port ONLY through the indexed numeric
**slot bridge** (`packages/ai/src/prompts/slots.ts`): every numeric token of
the lead is replaced by `{N1}…{Nk}` before the call, the model returns prose
over the same slots, and values are substituted back after validation. Any
slot mismatch, malformed response, provider absence or call failure falls
back to the deterministic lead with `modelEnhanced: false`, and `aiCalls`
is incremented only when the bridge actually ran. The merchant's question
text itself is never sent — the provider sees structure, not data.

Threads persist per store (`ai_copilot_conversations` /
`ai_copilot_messages`, RLS-enforced): both messages write in one
transaction with the assistant payload (evidence + rendered fields) stored
verbatim, so history renders exactly what was answered — no recomputation,
no drift. `intent`/`matchedPattern` on the message keep the grammar
observable.

### Forecasting (`packages/forecasting`, ADR 33)

Deterministic and **method-versioned**, with the method string on every
result so UI/reports/copilot can state exactly how a number was produced:

| Method | Math | Floor |
|---|---|---|
| `revenue.weekly-seasonality.v1` | weekday profile over a 56d window (Mon–Sun), horizon-weighted projection | ≥14d history or `null` (honest "not enough data") |
| `demand.velocity.v1` | 60% last-14d / 40% last-30d unit velocity per variant | window-scoped |
| `stockout.velocity.v1` | on-hand ÷ demand velocity → days-of-cover, ordered by urgency | only at-risk rows returned |
| `churn.rfm.v1` | recency/frequency/monetary segmentation over the context window | top-N risks |

Revenue intervals derive from in-window residual σ, widened ×√(1+d/7) as
the horizon extends (z=1.28 ≈ 80% band); fit quality (R²) is recorded.
This is deliberately NOT machine learning: the estimates are transparent,
reproducible, testable, and honest about what they are.

### Enterprise reports (`packages/reporting`, ADR 34)

- **Periods** (`periods.ts`) — closed-period math in UTC (daily = yesterday,
  weekly = last ISO week, monthly/quarterly = previous calendar unit);
  `closedPeriodFor`/`priorPeriodFor`/`periodLabel`, unit-tested at
  boundaries (month edges, week 1, year roll).
- **Sections** (`sections.ts`) — deterministic data assembly from
  daily/revenue metrics, top products, open+executed recommendations and
  the forecast service: KPIs with prior-period deltas, highlights,
  performance table, top-products table, forecast strip, AI-action counts.
  `REPORT_METHOD_VERSION = 1` stamps the row.
- **Summary** (`@profit/ai` `service/executive.ts`) — the EXECUTIVE agent
  writes a 2–4 sentence summary through the same slot bridge; absent a
  provider, a deterministic summary renderer composes the same facts. The
  stored `executiveSummary` is always literal text — slots never persist.
- **PDF** (`pdf.ts`) — reuses M6's zero-dependency `buildPdf` via the new
  paginated `buildPdfDocument` (title + subtitle, heading/paragraph/table
  sections with repeated headers mid-break, `Page X of Y`). Bytes live in
  `reports.pdf_bytes` with `pdf_size_bytes` + a deterministic filename
  (`{store-slug}-{kind}-{startIso}.pdf`).
- **Service** (`service.ts`) — `generateForPeriod` is a **convergent
  upsert** on `(store, kind, periodStart)`: BUILDING → READY|FAILED with
  `completedAt`/`errorMessage`; regenerating a period rebuilds the same row
  (idempotent, never duplicates). `deliver` sends the email through the M6
  `EmailSender` port, idempotent per UTC day via `lastEmailedOn`, returning
  typed outcomes (`{sent}` / reasons `email-unavailable`,
  `already-sent-today`) instead of pretending. `runDue` (worker tick) walks
  ACTIVE stores × due kinds from `store_settings.report_preferences`,
  generates, files an in-app System notification (24h dedupe window) and
  emails when `emailDelivery` is on (recipient = pref or store contact).
- **Jobs** (`jobs.ts`) — `ReportsTickJob` on the new `reporting` queue
  every `REPORTS_TICK_INTERVAL_MS` (default 6h, min 5min);
  `ReportsGenerateJob` (attempts 3) for job-level retries.

### API + web surfaces

`apps/api`: `modules/copilot` (`POST /ask`, `GET /conversations`,
`GET /conversations/:id` — `copilot:read`/`copilot:ask`), `modules/reports`
(`GET /`, `POST /generate`, `GET /:id`, `GET /:id/pdf`, `POST /:id/email` —
`reports:read`/`reports:manage`), `/analytics/forecasts` (rides
`analytics:read`, ADR 35). Server composition constructs Gemini provider +
SMTP sender only when env is configured (both nullable — the honesty
outcomes depend on the null path being first-class).

`apps/web`: two lazy-loaded sections in the nav registry (18 surfaces now).
Copilot: conversation rail, evidence-structured bubbles (shared
`FactsTable` with the report drawer), method/confidence badges,
"polished by Executive agent" badge only when the bridge truly ran,
suggested prompts, read-only handling for `copilot:read`-without-`ask`.
Reports: schedule preferences card (kinds + email toggle + recipient →
nested settings patch), vault table polling while anything is BUILDING,
kind filter, generate dialog, detail drawer (KPIs, highlights, tables,
forecast band, Executive summary), PDF download via the authenticated
binary client, email action with typed outcome toasts. Both surfaces are in
the axe WCAG 2.2 AA gate.

## 3. Key decisions (ADRs 32–36)

Recorded in `ARCHITECTURE.md` §7. Two worth repeating:

- **Numbers never cross the provider port.** This extends M4's anti-
  hallucination invariant ("numbers belong to rules") from decisions to
  prose: even when an LLM polishes a sentence, the figures are substituted
  out, moved by index, and restored. There is no code path on which a
  model-generated number reaches a merchant.
- **Convergent report rows.** A report is identified by
  `(store, kind, periodStart)`; building twice converges on one row. Manual
  and scheduled generation share the same path, so a merchant clicking
  "Generate" for a period the tick already produced simply rebuilds it —
  no duplicates, no races, no special cases.

## 4. Failure modes and their handling

| Failure | Handling |
|---|---|
| AI provider absent/failing mid-ask | deterministic full answer, `modelEnhanced: false`, `aiCalls` not counted |
| Slot bridge mismatch (model dropped/invented a slot) | validation rejects → deterministic fallback |
| <14d metrics history | revenue forecast is `null`; UI/report state the minimum-history reason |
| Email sender unconfigured | report still builds; deliver returns `email-unavailable`; surfaces say exactly that |
| Report build throws mid-way | row ends FAILED with `errorMessage`; regenerate rebuilds the same row |
| Worker tick mid-generation crash | BUILDING row is rebuilt convergently on the next run/manual trigger |
| Merchant re-asks in same thread | conversation continuity by id; tenant scope enforced on every query |

## 5. Production notes found during M8

- **PGlite bytea** surfaces as `Uint8Array`, whose `toString()` is a CSV of
  byte values — schema `fromDriver` normalizes to `Buffer`, so stored PDFs
  decode correctly in both PGlite (tests) and postgres.js (prod) drivers.
- The seed permission matrix is the idempotent source of truth — M8's four
  codes were added there; existing environments get them by re-running the
  seed (no data migration needed; RBAC rows upsert by code).

## 6. Verification (this milestone's evidence)

- Full workspace: **1165 tests green + 4 Redis-gated skips** (18 projects),
  +133 over M7: forecasting 11 · reporting 29 · ai 158 total (incl.
  intents/evidence/composer/executive/slots/copilot-service + registry/
  catalog) · api 288 total (+18: copilot 6, reports 12) · worker 53
  (+5 report jobs) · web 216 (+11: copilot page 4, reports page 7, axe
  suite now 7 surfaces).
- New-package coverage: forecasting 95.7 stmts / 83.3 branch · reporting
  94.7 / 83.3 · ai 91.5 / 78.5 — all above the 80/75/80/80 gates.
- TypeScript strict (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`) clean across the workspace; build green
  (api/worker bundles + web vite chunks).
- Migration drift zero: `drizzle-kit generate` on the committed schema
  outputs "No schema changes"; `0008` carries the hand-appended RLS
  DO-block + `profit_app` grants per the M1 convention.
- RLS: new tenant tables sit under the same `profit_app` policy block;
  cross-tenant reads via `withStoreScope` return zero rows (integration-
  tested at the API layer for copilot conversations and reports).

## 7. Deferred (honest list)

- **Public API + OpenAPI + partner webhooks, white label, mobile apps** —
  Phase 4/5 of spec part-08, re-scoped to M9+ (ROADMAP updated). Phase 3 is
  complete as specced; nothing below is needed for it.
- **Conversational tool-calling copilot** (copilot that reads the M6 tool
  registry / writes drafts) — the intent grammar covers the read-only Q&A
  surface; action-taking copilot turns require a merchant-confirmation UX
  contract that is Phase-4 scope, not a stub here.
- **ML-backed forecasting** (holt-winters/Prophet class) — deliberately not
  faked in v1; the deterministic methods are versioned so a real model
  arrives as `*.v2` with backtested intervals.
- **Report templates/layout customization** — the section set is fixed per
  kind; merchant-authored layouts are enterprise roadmap.
- **Report retention sweep** — rows + bytes accumulate; at the PDF-size
  trigger (see RISKS #20) a retention policy + object-storage spill lands.
  Watch item, not a defect.
- **Exec summary localization** — summaries/highlight strings are English
  v1 (matches the rest of the product surface).
