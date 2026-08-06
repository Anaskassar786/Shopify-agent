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
| Types | `pnpm -r run typecheck` | TS strict, zero errors (15 projects) |
| Tests | `pnpm -r run test` | all suites green = 722 |
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
- ◻ M6 Automation Center + Campaigns — next

Migrations: `packages/db/drizzle` (0000 core · 0001 shopify core · 0002 RLS · 0003 data plane · 0004 notifications+onboarding · 0005 AI engine · 0006 billing+growth).
Seed after migrate: `pnpm --filter @profit/db run seed`.
