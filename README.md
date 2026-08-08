# PROFIT TOOL AI

**Enterprise AI decision support & revenue automation for Shopify merchants.**
Not a dashboard — an AI employee inside the store: it monitors, detects opportunities, explains every recommendation, and safely executes merchant-approved automations with measurable revenue impact.

> Specification: [`docs/spec/`](docs/spec/) (12-part master PRD) · Architecture: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) · Plan: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Risks: [`docs/RISKS.md`](docs/RISKS.md)

## Monorepo layout

```
apps/
  api/        Express 4 · TypeScript · /api/v1 · Shopify OAuth+webhooks · sync/analytics/catalog/AI APIs
  worker/     BullMQ consumers: sync modules · webhook processing · analytics · AI runs/executions (M2/M4)
  web/        React 19 · Vite · embedded app shell · AI command center + decision queue (M3/M4)
packages/
  types/      API envelope + domain enums (single source of truth)
  db/         Drizzle ORM schema · migrations · pooled client · RLS
  sync/       Data plane: REST DTOs · idempotent writers · sync runner · webhook appliers (M2)
  queue/      Job port + BullMQ/memory drivers · durable background_jobs mirror (M2)
  cache/      Cache port + Redis/memory drivers · tenant-versioned StoreCache (M2)
  shopify/    Shopify HTTP client · paginators (REST cursor + cost-aware GraphQL) · HMAC (M2)
  crypto/     AES-256-GCM secret storage helpers (M2)
  logger/     pino logger factory, shared by api + worker (M2)
  notifications/ NotificationService: persist → publish · audience-scoped reads (M3)
  ui/         Design system (M3)
  ai/         AI decision engine: provider port+Gemini · context builder · rules · calibration ·
              recommendations · executor · attribution (M4)
  billing/    Billing + growth plane: plans/entitlements · Shopify charge adapter · trial
              lifecycle · usage metering · reconcile · churn · funnel · growth analytics (M5)
  automation/ Workflow DAG engine + executor · campaign sender · closed template catalog ·
              HMAC tracking · zero-dep CSV/XLSX/PDF exporters · support tickets (M6)
  forecasting/ Deterministic, method-versioned forecasting: weekly-seasonality revenue ·
              velocity demand · stockout projections · RFM churn (M8)
  reporting/  Enterprise reports: closed-period sections · Executive-agent summary ·
              PDF vault · scheduled tick + email delivery (M8)
```

## Quick start

```bash
corepack pnpm install
docker compose up -d                 # Postgres 16 + Redis 7
cp .env.example apps/api/.env        # fill values (never commit)
pnpm --filter @profit/db run migrate
pnpm dev                             # api on :3000  →  /live /ready /health
pnpm dev:worker                      # worker on :3100 (health) — BullMQ when REDIS_URL set
```

## Quality gates (must be green before merge)

| Gate | Command | Standard |
|---|---|---|
| Types | `pnpm -r run typecheck` | TS strict, zero errors (18 projects) |
| Tests | `pnpm -r run test` | all suites green = 1165 passed + 4 Redis-gated skips (18 projects) |
| Coverage | per-package `vitest run --coverage` | gated ≥80 stmt / 75 branch |
| Build | `pnpm -r run build` | api + worker bundles, web vite build (lazy chunks) |
| Migrations | `pnpm --filter @profit/db run generate` | schema changes = migrations only |

CI: `.github/workflows/ci.yml` (typecheck → tests → build → integration vs real PG/Redis on push).

## Invariants (do not violate)

1. Business logic never imports provider SDKs — ports & adapters (AI, email, storage).
2. `store_id` on every business table; tenant middleware scopes every request.
3. AI output = structured JSON, Zod-validated, DB-cross-checked; nothing high-impact executes without merchant approval via the recommendation state machine.
4. Webhooks ack fast, verify HMAC, dedupe by delivery id, process in background jobs.
5. No secrets in code/logs; redaction is enforced and unit-tested.

## Status

- ✅ **M0 Foundation** — monorepo, shared types, tenant schema + migrations, API skeleton (config/logging/envelope/errors/health)
- ✅ **M1 Shopify App Core** — OAuth install (single-use state) · session-token→JWT auth with refresh rotation · AES-256-GCM token storage · HMAC + dedupe webhook intake (APP_UNINSTALLED + GDPR handled) · RBAC · Postgres RLS · [milestone doc](docs/architecture/M1-shopify-core.md)
- ✅ **M2 Sync Engine + Data Plane** — `apps/worker` (BullMQ) + `@profit/queue`/`cache` ports with durable `background_jobs` mirror · 7 sync modules with cursor checkpoints, crash resume and incremental watermarks · durable webhook appliers (18 topics, replay-safe upserts) · subscription reconciliation + schedules · analytics pre-aggregation (4 metric tables, advisory-lock convergent) · tenant-versioned cache invalidation · `/sync` `/analytics` `/catalog` APIs · 240 tests · [milestone doc](docs/architecture/M2-sync-data-plane.md)
- ✅ **M3 Web Shell + Dashboard** — `packages/ui` design system (dark-default tokens, 14 components, SVG charts) · `apps/web` embedded app (App Bridge v4, one-origin serving from the API, lazy route chunks) · 15-section shell with realtime notification drawer + ⌘K palette/global search · live dashboard (revenue/orders/customers/AOV, store health, recent activity, inventory alerts) · catalog/inventory/audit/billing/settings pages · onboarding wizard + trial · offline-aware QueryBoundary everywhere · 121 new tests (465 total) · [milestone doc](docs/architecture/M3-web-shell-dashboard.md)
- ✅ **M4 AI Revenue Loop v1** — `packages/ai` decision engine: Gemini provider (structured JSON, repair pass, per-call micro$ metering) · PII-minimized Business Context Builder + deterministic Store Health · 8-rule catalog (numbers come from rules, never the model) · 5 agents with versioned prompts · server-side calibration (confidence caps, priority floor, risk max, acceptance-rate learning) · recommendations + immutable evidence + explainability UI · CAS approval state machine · discount/email tools with idempotent executions + step resume · automation v1 (MANUAL/SEMI_AUTOMATIC/FULLY_AUTOMATIC with dual caps) · attribution v1 (checkout-token → discount-code → window chain) · 8th sync module CHECKOUTS · AI Command Center, decision queue, automation policy pages · AI overview card on the dashboard · +132 M4 tests (597 total) · [milestone doc](docs/architecture/M4-ai-revenue-loop.md)
- ✅ **M5 Billing + Growth Engine** — `packages/billing`: plans + entitlement matrix as data · Shopify recurring charges (subscribe → preserved-trial decision screen → live-API callback, daily reconcile sweep — Shopify pushes no billing webhooks) · ONE access gate (`evaluateAccess`) wired into API guards, scheduled-AI fan-out and the email-execution preflight · D0–D3 trial journey (hourly tick: nudges → expiry → suspension, ledger-deduped sends) · convergent `usage_records` metering + quota checks (typed UPGRADE_REQUIRED / QUOTA_EXCEEDED refusals) · `billing_events` ledger (install seeds TRIAL_STARTED in the same tx) · `engagement_events` funnel with partial-unique milestone dedupe (7 milestones, OAuth→paid) · ROI read-model (measured attribution ÷ metered AI cost, honest cost side) · key-gated read-only Super Admin API + standalone `/admin` web console (memory-only key, cross-tenant by documented design) · Billing page v2 (plan comparison, meter bars, ledger feed, ROI block, Shopify charge flow with `_top` redirect) + upgrade-CTA denial UX · +125 tests (722 total) · [milestone doc](docs/architecture/M5-billing-growth.md)
- ✅ **M6 Automation Center + Campaigns** — `packages/automation` plane: workflow **DAG engine** (server-authoritative validator on save/activate; immutable versions; trigger/condition/wait/send-email/send-sms/tag/discount nodes; delay parking with tick-resume; per-step idempotent run ledger) · **builder UI** (pure graph-ops module + layered canvas with automatic YES/NO branch discipline, lint-gated activate) · three trigger kinds (manual · 5-field UTC cron materialized by the worker tick · Shopify-webhook events deduped per delivery) · **email/SMS campaign centers** (templates on a closed 11-variable catalog with honest 409s · A/B variants with merchant-picked winner · sender-appended unsubscribe + durable suppression ledger) · **tracking pixel/links** on stateless HMAC tokens (threat model in the milestone doc — no session, no tenant data in claims, verification never touches Postgres hot-path) · **campaign batching** (50/batch · 2s throttle · BullMQ jobId dedupe against double-send races) · **zero-dependency exports** (own CSV/XLSX/PDF writers · 50k-row cap · one-click audit-log export) · **support tickets** (merchant workspace + cross-tenant operator inbox, both on one thread ledger) · **admin v2** (15-min step-up sessions gate every write — key still never stored; ticket reply/transition, trial extension with `TRIAL_EXTENDED` billing event, time-boxed access overrides, operator action log) · 16-section shell is fully live (zero roadmap placeholders left) · +252 tests (974 passed + 4 Redis-gated skips) · [milestone doc](docs/architecture/M6-automation-campaigns.md)
- ✅ **M7 App Store Readiness** — **public legal plane** (`/legal/*`: typed content modules, server-rendered self-contained pages, prod-required `SUPPORT_EMAIL`+`LEGAL_ENTITY_NAME`, dedicated per-IP limiter; linked from the Support page's Legal & policies card, which now reads the configured support mailbox from the API instead of a hardcoded address) · **SOC-2-lite access review** (computed read model over users×memberships×roles×permissions + `access_overrides` + `platform_admin_actions` — zero new tables; admin API + console tab with roster/permission-breadth, live overrides, operator writes, step-up grants) · **consolidated security suite** (alg=none/wrong-secret/expired/wrong-audience JWT forgeries, typed 400/413 payload envelopes, SQLi-shaped search input physically tenant-bounded, header/query tenant-spoof proof, admin-gate probing, CSP/CORS) · **in-process load suite** (30× parallel mixed-tenant reads with hard isolation, 30× duplicate-delivery webhook flood → all acked in budget + exactly one durable handoff + zero DLQ, 70-burst limiter saturation with neighbour isolation; asserted p95 budgets) · **axe WCAG 2.2 AA gate** (axe-core on the real component tree: Dashboard, Billing, Support, Exports, operator console — zero violations) · **generated `shopify.app.toml`** (registry- and scope-parity-tested manifest renderer, deployed via `manifest:render`) · listing/checklist/brand/capture/video pack in `docs/appstore/` + runbooks + `CHANGELOG.md` (product version **1.0.0**) · **three real production fixes**: SPA serving order (embedded app would have 404'd), typed 413 (was 500), cache-driver shutdown lifecycle · +58 tests (1032 passed + 4 Redis-gated skips) · [milestone doc](docs/architecture/M7-appstore-readiness.md)
- ✅ **M8 Phase 3: AI Copilot + Advanced Forecasting + Enterprise Reporting** — **AI Copilot** (`packages/ai/copilot`: closed 10-intent grammar routes questions → deterministic evidence packs built from the M4 business-context builder + M8 forecasts + open recommendations; answers render FROM evidence — the model can never invent numbers; optional Executive-agent lead rephrase via the indexed numeric slot bridge `{N1}…{Nk}` so figures never cross the provider port in either direction; threads persisted per store with RLS) · **forecasting package** (deterministic + method-stamped: `revenue.weekly-seasonality.v1` weekday-profile projection with residual bands widened by horizon · `demand.velocity.v1` 14d/30d blend · `stockout.velocity.v1` days-of-cover projections · RFM churn risks — no fake ML anywhere) · **enterprise reports** (`packages/reporting`: closed-period DAILY/WEEKLY/MONTHLY/QUARTERLY sections reusing M6's PDF writer + an Executive-agent summary; convergent per (store, kind, period) upsert — regenerate never duplicates; 6h worker tick closes due periods per store preferences; PDF bytes in Postgres with a deterministic filename; email delivery via the M6 SMTP sender, idempotent per UTC day, honesty-typed outcomes like `email-unavailable`) · **two new agents** (EXECUTIVE prose-writer deliberately outside the rule run-order; PRICING extends the run-order with a margin-checked uplift rule) · **new APIs** `/copilot` (ask/conversations), `/reports` (vault generate/detail/PDF/email), `/analytics/forecasts` — RBAC `copilot:read/ask`, `reports:read/manage` seeded idempotently · **two new web surfaces** (Copilot chat with evidence tables + method/confidence badges; Report vault with schedule preferences, sections drawer, PDF download, email action — both in the axe WCAG gate) · migration 0008 · +133 tests (1165 passed + 4 Redis-gated skips) · [milestone doc](docs/architecture/M8-phase3-copilot-forecasting-reports.md)
- ◻ M9+ Phase 4–5 — next (public API + partner webhooks, white label, mobile companion)

Migrations: `packages/db/drizzle` (0000 core · 0001 shopify core · 0002 RLS · 0003 data plane · 0004 notifications+onboarding · 0005 AI engine · 0006 billing+growth · 0007 automation+campaigns · 0008 copilot+reports).
Seed after migrate: `pnpm --filter @profit/db run seed`.
