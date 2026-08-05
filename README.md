# PROFIT TOOL AI

**Enterprise AI decision support & revenue automation for Shopify merchants.**
Not a dashboard — an AI employee inside the store: it monitors, detects opportunities, explains every recommendation, and safely executes merchant-approved automations with measurable revenue impact.

> Specification: [`docs/spec/`](docs/spec/) (12-part master PRD) · Architecture: [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) · Plan: [`docs/ROADMAP.md`](docs/ROADMAP.md) · Risks: [`docs/RISKS.md`](docs/RISKS.md)

## Monorepo layout

```
apps/
  api/        Express 4 · TypeScript · /api/v1 · Shopify OAuth+webhooks (M1+)
  worker/     BullMQ workers (M2+)      web/  React 19 + Vite embedded app (M3)
packages/
  types/      API envelope + domain enums (single source of truth)
  db/         Drizzle ORM schema · migrations · pooled client
  ui/         Design system (M3)
```

## Quick start

```bash
corepack pnpm install
docker compose up -d                 # Postgres 16 + Redis 7
cp .env.example apps/api/.env        # fill values (never commit)
pnpm --filter @profit/db run migrate
pnpm dev                             # api on :3000  →  /live /ready /health
```

## Quality gates (must be green before merge)

| Gate | Command | Standard |
|---|---|---|
| Types | `pnpm -r run typecheck` | TS strict, zero errors |
| Unit tests | `pnpm --filter @profit/api run test` | 30+ tests |
| Coverage | `npx vitest run --coverage` (apps/api) | ≥80% gated modules |
| Build | `pnpm -r run build` | deployables bundle |
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
- ✅ **M1 Shopify App Core** — OAuth install (single-use state) · session-token→JWT auth with refresh rotation · AES-256-GCM token storage · HMAC + dedupe webhook pipeline (APP_UNINSTALLED + GDPR handled) · RBAC · Postgres RLS · 107 tests / 89% coverage · [milestone doc](docs/architecture/M1-shopify-core.md)
- ◻ M2 Sync Engine + Data Plane — next

Migrations: `packages/db/drizzle` (0000 core · 0001 shopify core · 0002 RLS).
Seed after migrate: `pnpm --filter @profit/db run seed`.
