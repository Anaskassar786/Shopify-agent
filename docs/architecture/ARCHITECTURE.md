# PROFIT TOOL AI — System Architecture

> Status: APPROVED-BY-AUTHORIZATION (Part 12 execution directive)
> Derived from: `docs/spec/part-01` … `part-12`
> Author: Lead Architect (Arena Agent Mode)

---

## 1. System Context

PROFIT TOOL AI is a multi-tenant, embedded Shopify app: an AI decision-support and revenue-automation platform. The core loop, which every architectural choice must serve:

```
Shopify → Sync Engine → PostgreSQL → Analytics Engine → Rule Engine
  → AI Decision Engine → Recommendation Engine → Explainability Engine
  → Merchant Approval → Automation Engine → Impact Measurement
```

**Non-negotiable invariants (traceable to spec):**

| # | Invariant | Source |
|---|---|---|
| I1 | Business logic never imports a provider SDK (AI, email, storage) — ports & adapters only | P1/P10 |
| I2 | `store_id` on every business table; every request validated for merchant→store→permission→session→subscription | P1/P2/P12 |
| I3 | AI never executes high-impact actions without merchant approval; uncertain output → no automation | P3/P10 |
| I4 | AI responses are structured JSON, Zod-validated and DB-cross-checked before surfacing | P10 |
| I5 | Webhooks ack fast; heavy work in background jobs | P5/P12 |
| I6 | Every AI decision stored with evidence, never deleted | P3 |
| I7 | App remains functional after each milestone (incremental vertical slices) | P8 |
| I8 | Cloud-agnostic; Railway is deploy config, not code | P5 |

---

## 2. Repository Topology (pnpm monorepo)

```
Shopify-agent/
├── apps/
│   ├── api/                 # Express 4 · REST /api/v1 · authN/authZ · Shopify OAuth + webhooks
│   ├── worker/              # BullMQ consumers: ai, sync, email, sms, discount, analytics,
│   │                        #   notification, cleanup  (M2+)
│   └── web/                 # React 19 · Vite · embedded Shopify app (App Bridge) · Tailwind
├── packages/
│   ├── types/               # Shared contracts: API envelope, domain enums, DTOs (zero runtime deps)
│   ├── db/                  # Drizzle ORM schema · migrations · connection pool · RLS helpers
│   ├── sync/                # Data plane: REST DTOs · writers · sync runner · webhook appliers · analytics (M2)
│   ├── queue/               # Job port + BullMQ/memory drivers · durable background_jobs mirror (M2)
│   ├── cache/               # Cache port + Redis/memory drivers · tenant-versioned StoreCache (M2)
│   ├── shopify/             # Shopify transport: HTTP client · REST/GraphQL paginators · throttle · HMAC (M2)
│   ├── crypto/              # AES-256-GCM helpers, shared by api + worker (M2)
│   ├── logger/              # pino logger factory, shared by api + worker (M2)
│   ├── notifications/       # NotificationService: persist → publish · audience-scoped reads (M3)
│   ├── ui/                  # Design system (tokens → Tailwind theme, components, SVG charts) (M3)
│   ├── ai/                  # AI decision engine: provider port+Gemini · context builder · rule catalog ·
│   │                        #   calibration · recommendation service · executor · attribution (M4)
│   └── (config presets live at repo root: tsconfig.base.json)
├── docs/
│   ├── spec/                # 12-part PRD (source of truth)
│   └── architecture/        # This file + ADRs
├── docker-compose.yml       # Local Postgres 16 + Redis 7 (+ optional worker deps)
├── .github/workflows/       # CI: typecheck → test → build → deploy
└── .env.example
```

**Why monorepo:** shared types/db/ui across api+worker+web prevents the duplicate-code trap; every deployable stays independently buildable (Part 12's "separate services" at 1k–10k scale = promoting `apps/*` to separate Railway services, not a re-architecture).

**Extractable-module rule:** `apps/api/src/modules/<domain>` follows `routes → controllers → services → repositories`. At 10k+ scale a module becomes a service by lifting its folder; the port interfaces in `packages/types` stay stable. This is how we honor Part 12's microservice future *without* paying microservice cost today.

---

## 3. Data Architecture (PostgreSQL 16 + Drizzle)

- **Migrations only** — schema never edited manually; `drizzle-kit generate` per change, reviewed in PR.
- **ID strategy:** UUIDv7-style (`gen_random_uuid()` on PG16) PKs; public-facing identifiers exposed raw (no sequential enumeration).
- **Multi-tenancy (defense in depth):**
  1. Tenant middleware resolves `store_id` from session → AsyncLocalStorage context.
  2. Repository base class auto-scopes every query (`WHERE store_id = :ctx`), impossible to forget.
  3. Postgres Row-Level Security policies per business table (M2; backstop if a query path bypasses the repository).
- **Identity model:** `users` ↔ `user_store_memberships` (m:n, role per membership) — enables Part 8 agencies/multi-store later with zero schema surgery. Future `organization_id` added as a column once organizations exist.
- **Table groups (Part 2 taxonomy, extended by flagged deltas):** iam · merchant · shopify · customers · products · orders · discounts · recommendations · automation · notifications · analytics · billing · audit · jobs · **platform** (feature_flags, engagement_events, ai_prompts, ai_call_logs, feedback, support_tickets — deltas agreed in Part notes).
- **Soft deletes** on merchant-visible entities (`deleted_at`); hard-delete only via GDPR-erasure service which also purges AI payloads of PII.

---

## 4. Application Layers

### 4.1 API (apps/api)
- Express 4 + TypeScript strict, ESM, bundled with tsup for deploy.
- Middleware order: `requestId → pino-http → helmet → cors → compression → rateLimit → sessionToken/JWT → tenantResolver → subscriptionGate → permissionGuard(rbac) → zod(body,query,params,headers) → controller`.
- **Uniform envelope** (Part 2): `{ success, message, data, meta, errors, timestamp, request_id }`; `request_id` echoed in header `x-request-id` and shown in UI error states (Part 9).
- **Error taxonomy:** `AppError { code, httpStatus, details, expose }` → global handler; classes: `ValidationError, AuthenticationError, AuthorizationError, ShopifyApiError, DatabaseError, AiProviderError, QueueError, RateLimitError, NotFoundError, ConflictError, BillingError, MaintenanceError`.
- Versioned mounts: `/api/v1/*`; internal `/health /live /ready`; `/admin/*` = platform surface behind **separate auth flow + audience claim** (Part 4 Super Admin isolation).
- GraphQL: used **for Shopify Admin API calls** only (versioned client with cost-aware retry/backoff for Shopify rate limits); app API stays REST per Part 2. WebSockets: notification + automation-status channels (M3).

### 4.2 Worker fleet (apps/worker)
- BullMQ + Redis behind the `@profit/queue` **port** (memory driver for hermetic tests); one process registers one consumer per queue (8 queue names defined; M2 consumes `sync`, `analytics`, `cleanup`) → horizontally scalable by process count.
- Every job carries `{ jobId, storeId, idempotencyKey, traceId }`; handlers are **idempotent** (unique constraints + upserts) — duplicates from webhook retries are no-ops. *(M2 as-built: payload Zod schemas shared producer↔consumer; retry budgets + timeouts on the definition, per-driver.)*
- Webhook intake publishes to `sync` queue within the ack window; HMAC verified synchronously before enqueue. *(M2 as-built: durable handoff — intake persists `webhook_logs` RECEIVED + enqueues `webhook.process` keyed `webhook:{logId}`; worker applies the payload.)*
- Postgres `background_jobs/failed_jobs/job_retries` = durable audit mirror of BullMQ state (dead-letter → `failed_jobs` + admin alert). *(M2 as-built: `JobPersistence` subscribes to port events and mirrors queued→RUNNING→COMPLETED/DEAD_LETTERED + every retry row.)*

### 4.3 Sync Engine
- Modules: products, customers, orders, inventory, collections, discounts, metafields. *(M2 delivered, in `FULL_SYNC_ORDER` so FK resolution is local.)*
- Modes: initial full (post-install, paginated cursor walk, resumable checkpoints in `sync_history`), incremental (webhook-driven), manual, scheduled (safety-net cron). *(M2 as-built: FULL runs resume from the last per-page `page_info` checkpoint; incrementals use last-completed `started_at − 60s` overlap watermarks; inventory+metafields run FULL daily since they lack `updated_at_min`.)*
- Conflict rule: Shopify is source of truth (last-write-wins) — documented; local-only projection fields never overwritten.
- Cache invalidation after writes. *(M2 as-built: tenant-versioned keyspace — `CacheInvalidator` INCRs `v:{storeId}:{domain}` so an entire tenant domain invalidates in O(1). M3 added the pub/sub port for the realtime event channel (worker → API WS gateway → browser): `packages/cache createPubSub` with memory + Redis drivers, per-tenant channels `rt:{storeId}`, at-most-once delivery documented in the port contract.)*

### 4.4 AI Layer (ports & adapters)
```
packages/ai  (M4 as-built — shared by api (reads/approves) and worker (runs/executes))
  ├── provider/port.ts                  AiProvider port: typed structured completion
  ├── provider/gemini.ts                ← only network edge; raw fetch (fetchImpl injectable), JSON-mode,
  │                                     repair pass, retry, per-model micro$ pricing table
  ├── context/builder.ts + health.ts    Business Context Builder (RLS-scoped, PII-minimized) +
  │                                     deterministic Store Health (6 weighted components)
  ├── rules/catalog.ts                  8 versioned deterministic rules — money/subjects/estimates
  ├── prompts/registry.ts               5 agents as versioned prompt packs (promptId@vN, Git-audited)
  ├── scoring.ts                        Server-side calibration: confidence caps/tiers, priority
  │                                     floor/+1 cap, risk max, acceptance-rate learning adjuster
  ├── service/recommendations.ts        RecommendationService: CAS state machine, dedupe fingerprints,
  │                                     evidence snapshot, list/detail read-models
  ├── service/decision.ts               Run orchestration: rules → agents → calibration → persistence;
  │                                     typed unavailability, per-run call cap (cost circuit breaker)
  ├── service/executor.ts + tools/      Typed tool registry (discount, email via SMTP), idempotent
  │                                     action_executions with per-step checkpoints/resume
  └── service/attribution.ts + overview.ts  Attribution chain + command-center read-models
```
- **Anti-hallucination is structural (M4 decision, see M4 doc §3):** deterministic rule constants own all numbers; the model produces prose/confidence only, then server-side calibration re-derives what persists. Unknown firingRefs dropped; `finalRisk = max(model, rule)`; priority floor from rule, +1 rank cap, CRITICAL only from rules.
- **Safety:** action whitelist + confidence thresholds + approval state machine (`PENDING_APPROVAL → APPROVED/REJECTED → EXECUTING → EXECUTED/FAILED → MEASURED`; + `EXPIRED`, `SUPERSEDED`) enforced in RecommendationService (CAS on `stateVersion`), re-verified at execution; FULLY_AUTOMATIC autopilot requires confidence ≥ 80, risk ≠ HIGH and both merchant caps.
- **Observability:** every call → `ai_call_logs` (request digest, model, tokens, micro$ cost, latency, prompt version) feeding both Super Admin and per-merchant usage metering; runs close into `ai_runs` (COMPLETED / PROVIDER_UNAVAILABLE / FAILED — no PARTIAL status; agent failures degrade gracefully inside a completed run).
- **Prompt storage:** versioned code packs in v1 (`promptId@promptVersion`, versioned in Git + logged per call); db-backed `ai_prompts` arrives with A/B prompts in M6 campaigns.

### 4.5 Rule Engine
- Deterministic predicates over pre-aggregated metrics; merchant-defined rules as versioned JSON (create/enable/disable/prioritize/simulate/test).
- Fires **before** AI: candidate signals + evidence rows → AI ranks/quantifies/explains. Rules also post-validate AI output (Rule Validation step in Part 10 flow).

### 4.6 Automation & Workflows
- Workflow definitions = versioned DAG JSON; `workflow worker` executes with durable step-state in `automation_jobs` (survives restarts for "wait 24h" steps); compensation steps for partial failures.
- Execution preflight: re-check approval, re-check plan entitlements, re-check confidence — stale approvals never auto-run (I3).

### 4.7 Billing & Entitlements
- Shopify Billing API (managed pricing compatible): plans as **data** (`plans` + JSON entitlement matrix), usage meters in `usage_records` (ai_calls, emails, sms, automation_runs, seats, stores).
- Middleware gate: `entitlement.check(storeId, capability|quota)` — plan defaults, per-merchant overrides (support tools, add-ons, AI credits).
- Trial engine: day-partitioned lifecycle jobs (Day 0/1/2/3 prompts + emails), grace period → `suspended`.
- Attribution: discount-usage tags, draft-order tags, campaign UTM → `merchant_actions` ↔ `revenue_metrics` join; modeled estimates labeled as modeled.

### 4.8 Frontend (apps/web)
- React 19, Vite, React Router, TanStack Query, Tailwind v4 (tokens from `packages/ui`), Lucide. *(M3 as-built deviations from the plan, per rule 6: **hand-rolled SVG charts instead of Recharts** — exact token colors, ~1.6 KB chunk, deterministic math, no 400 KB chart lib; **no React-Hook-Form/Framer Motion yet** — forms are one-field controlled inputs where RHF would be ceremony; both remain addable without rewrites if M4–M6 forms grow.)*
- Shopify App Bridge v4 (CDN, meta-tag auto-init): Shopify session token → `/auth/session` exchange → first-party JWT in memory + rotating refresh (`profit.refresh.v1`); every API call carries `Authorization: Bearer`; no cookies inside the iframe.
- Route-per-sidebar-section (15 sections, Part 9) driven by ONE section registry (`shell/sections.ts`) that powers nav, palette, guards and tests; every page is a lazy chunk; feature-folder per domain; skeleton/empty/error/offline states standardized via `QueryBoundary` + `packages/ui` primitives; command palette ⌘K + grouped global search (`/search`, per-permission groups).
- Realtime: WS at `/api/v1/realtime` (JWT on upgrade) → per-store channel `rt:{storeId}` via `packages/cache` pub/sub (memory driver in dev/test, Redis in prod) → client maps event kinds to TanStack invalidations + toasts. The socket never writes cache; REST stays the source of truth.
- `AiConfidenceBadge`, `PriorityBadge` etc. use WCAG-checked token pairs (build-time lint). *(M3: ai/confidence tokens landed in `tokens.css`; badges arrive with the M4 AI surfaces.)*

### 4.9 Cross-cutting
- **Config:** zod-validated env at boot, fail-fast; per-environment; never logged.
- **Secrets:** Shopify offline tokens encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`, rotation = dual-key decrypt window).
- **Logging:** pino JSON; redaction list (authorization, cookies, tokens, password, secret, apiKey, payment); bindings `{requestId, storeId, userId, service}`; levels INFO/WARN/ERROR/DEBUG(+CRITICAL alias).
- **Caching:** Redis with versioned key namespacing + invalidation events from sync engine.
- **Feature flags:** platform-managed, per-merchant overrides, evaluated in middleware; maintenance mode with admin bypass.
- **Exports:** S3-compatible object storage behind `StorageProvider` port; export worker generates CSV/XLSX/PDF, signed-URL delivery, retention policy.

---

## 5. Testing Strategy

| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | services, rules, guardrails, pricing math, envelope, errors | PR |
| Integration | Vitest + Testcontainers (PG/Redis) | repositories, webhook pipeline, queue idempotency, sync engine | PR |
| Contract | Zod schemas shared client↔server (/packages/types) | API DTO drift | PR |
| E2E | Playwright | install→OAuth→sync→recommend→approve→automate→measure (dev store) | Nightly + release |
| Load | k6 | webhook storm, dashboard p95, 10/100/1k/sync scenarios (targets: API p95 <500ms, plan <300ms; dashboard <2s) | Release |
| Security | Suite: JWT expiry/forgery, HMAC tamper, replay, permission escalation, injection | PR (auth/billing/webhook paths) | PR |

Coverage target ≥80% on services; `no explicit any` enforced by lint rule.

---

## 6. CI/CD & Environments

- **Pipeline (.github/workflows/ci.yml):** install → lint → typecheck → unit → integration (services via GitHub Actions service containers) → build → (main) deploy Railway staging → smoke tests → promote production. Any critical failure blocks.
- **Railway services:** `api` (stateless, N replicas), `worker` (M replicas), `web` (static, CDN), Postgres (Railway PG w/ daily backup + PITR), Redis.
- **Rollback:** redeploy previous image; migrations always expand-then-contract (no destructive change in same release as code depending on old shape).
- **SemVer + CHANGELOG.md**; release = tagged commit.

---

## 7. Key Decisions (ADR summary)

1. **Modular monolith over microservices** (Part 12 scale plan: justified to 10k stores; extraction path defined).
2. **pnpm workspaces over Turborepo** initially (fewer moving parts; remote caching adds value later — revisit at CI-cost pain).
3. **BullMQ/Redis** mandated by P3; Postgres job tables serve as durable audit mirror, not the runtime queue.
4. **Redis is mandatory infrastructure** (cache + queue + rate-limit + pub/sub) — implicit in P2/P3/P5, explicitly adopted.
5. **Drizzle + postgres.js**, transaction-scoped `withTenantContext()` helper enforcing I2.
6. **RLS** as second tenant defense (M2).
7. **GraphQL only toward Shopify**, REST toward app clients (P1 vs P2 reconciliation).
8. **Many-to-many user↔store from v1** (agency/multi-store future, P8).
9. **Structured AI output enforced by code**, not prompt instructions (P10).
10. **Agent abstraction in v1** with 5 agents as configs (P8/P10); tool registry designed MCP-compatible.
11. **Three mandatory GDPR webhooks added** (`customers/data_request`, `customers/redact`, `shop/redact`) — compliance-required beyond P2's list.
12. **Export files in object storage**, never in DB/container FS (P4/P5 reconciliation).
13. **M4: AI engine as `packages/ai`** (shared by api+worker, same precedent as `packages/sync`), **Gemini over raw `fetch`** (JSON-mode + repair + precise micro$ costing; SDK invariant I1 intact via the port), **numbers owned by deterministic rules** (anti-hallucination by construction, not by prompt instruction).
14. **M4: 8th sync module CHECKOUTS** + `checkouts/create|update` webhooks (20 business topics) so cart recovery uses real abandoned-checkout data and attribution can join by checkout token / discount code.
15. **M4: `ai_runs` completed-write-only** (durable `background_jobs` is the live-progress mirror), **`ADVISORY` action type** (record+notify, executes inline), **automation preferences via `PATCH /store/settings`** nested-merge (one write path for merchant-controlled behavior).
