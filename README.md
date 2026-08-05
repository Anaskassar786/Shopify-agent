# PROFIT TOOL AI

**Enterprise AI decision support & revenue automation for Shopify merchants.**
Not a dashboard — an AI employee inside the store: it monitors, detects opportunities, explains every recommendation, and safely executes merchant-approved automations with measurable revenue impact.

> Specification: [`docs/spec/`](docs/spec/) (12-part master PRD) · Architecture: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) · Plan: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Risks: [`docs/RISKS.md`](docs/RISKS.md)

## Monorepo layout

```
apps/
  api/        Express 4 · TypeScript · /api/v1 · Shopify OAuth+webhooks · sync/analytics/catalog APIs
  worker/     BullMQ consumers: sync modules · webhook processing · analytics · schedules (M2)
packages/
  types/      API envelope + domain enums (single source of truth)
  db/         Drizzle ORM schema · migrations · pooled client · RLS
  sync/       Data plane: REST DTOs · idempotent writers · sync runner · webhook appliers (M2)
  queue/      Job port + BullMQ/memory drivers · durable background_jobs mirror (M2)
  cache/      Cache port + Redis/memory drivers · tenant-versioned StoreCache (M2)
  shopify/    Shopify HTTP client · paginators (REST cursor + cost-aware GraphQL) · HMAC (M2)
  crypto/     AES-256-GCM secret storage helpers (M2)
  logger/     pino logger factory, shared by api + worker (M2)
  ui/         Design system (M3)
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
| Types | `pnpm -r run typecheck` | TS strict, zero errors (10 projects) |
| Tests | `pnpm -r run test` | all suites green = 240 |
| Coverage | per-package `vitest run --coverage` | gated ≥80 stmt / 75 branch |
| Build | `pnpm -r run build` | api + worker bundle |
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
- ◻ M3 Web Shell + Dashboard — next

Migrations: `packages/db/drizzle` (0000 core · 0001 shopify core · 0002 RLS · 0003 data plane).
Seed after migrate: `pnpm --filter @profit/db run seed`.
