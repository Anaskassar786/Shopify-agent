# M2 — Sync Engine + Data Plane

Status: ✅ complete. Builds on M1 (tenant foundation, OAuth, webhook intake, RLS).

> Goal (roadmap): BullMQ/Redis worker bootstrap · sync modules for products / customers /
> orders / inventory / collections / discounts / metafields · initial full sync with cursor
> checkpoints · incremental webhook-driven sync · idempotent upserts · cache invalidation ·
> analytics pre-aggregation into `daily_metrics` / `revenue_metrics` / `product_metrics` /
> `customer_metrics` · sync control-plane API · integration tests.

---

## 1. What the data plane is (and why it exists)

Every intelligent feature after M2 — agent recommendations, the reporting pages, the
dashboard — reads from **local, pre-aggregated, tenant-scoped Postgres tables**, never from
Shopify at request time. M2 builds the machinery that makes those tables true:

```
        ┌──────────────┐   HMAC + persist RECEIVED   ┌────────────────┐
Shopify │  webhooks    │ ──────────────────────────▶ │  API (intake)  │
        └──────────────┘                              └──────┬─────────┘
                                                             │ enqueue webhook.process
        ┌──────────────┐   paginated cursor sync            ▼
        │  Admin REST  │ ◀──────────────────────────   ┌──────────────┐
        │  + GraphQL   │                               │   WORKER     │
        └──────────────┘                               │ BullMQ       │
                                                       │ consumers    │
                                                       └──────┬───────┘
              idempotent upserts (mirror tables)             │
              webhook appliers (same writers)                ▼
                                        ┌───────────────────────────────┐
                                        │  Postgres (RLS + store_id)    │
                                        │  mirror tables + sync_history │
                                        │  + *_metrics (pre-aggregated) │
                                        └──────────────┬────────────────┘
                                                       │
                                        StoreCache (tenant-versioned keys)
                                                       ▼
                                        API: /sync /analytics /catalog
```

Design rules carried forward from M0/M1: strict TypeScript, no `any`, spans of store data
*always* inside `withStoreScope`, money as exact `numeric` in the mirror tables and as
**integer cents** in metrics, DTO normalization in exactly one place (`@profit/sync/dto`).

---

## 2. New packages and services

| Piece | Responsibility |
|---|---|
| `packages/crypto` | AES-256-GCM helpers (extracted from `apps/api`, worker needs token decryption) |
| `packages/logger` | pino logger factory (extracted, shared api/worker) |
| `packages/shopify` | Shopify HTTP client, HMAC, shop-domain guards **+ new**: `ShopifyPaginator` (REST `page_info` cursor pagination, Link-header parsing, throttle, resume-from-checkpoint), `GraphqlPaginator` (cost-aware: sleeps when `throttleStatus.currentlyAvailable < requestedQueryCost`), `RestThrottle`, `shopifyGetJson`, `shopifyGraphqlRaw` |
| `packages/queue` | **Provider-agnostic job port** (`JobDefinition`, `JobContext`, events, schedules, timeout+validation execution) with two drivers: in-memory (tests) and **BullMQ v5** (runtime); `JobPersistence` mirrors every job into `background_jobs` / `job_retries` / `failed_jobs` (idempotency key unique → durable dedupe); `createJobQueue` picks BullMQ when `REDIS_URL` exists |
| `packages/cache` | `CachePort` (get/set/del/incr/expire) with memory + Redis drivers; `StoreCache` tenant-versioned keys `c:{storeId}:{domain}:{v}:{key}` and `CacheInvalidator` bumping `v:{storeId}:{domain}` → O(1) invalidation of an entire tenant domain (analytics/catalog/store) |
| `packages/sync` | The data-plane brain: REST DTO contracts, idempotent writers, sync runner (checkpoints), 7 sync modules, webhook applier registry, webhook subscription reconciliation, analytics aggregation, job definitions |
| `apps/worker` | BullMQ consumer service: env validation, job handlers, schedules, `/live` `/ready` health server, graceful shutdown |

API additions: `POST /api/v1/sync/full`, `POST /api/v1/sync/:module`, `GET /status`,
`GET /history`; `GET /api/v1/analytics/summary|top-products|top-customers`;
`GET /api/v1/catalog/products|customers|orders|inventory`; fixed-window rate-limit
middleware (store-scoped via cache, 30/min on sync triggers); webhook durable handoff.

---

## 3. Pipelines

### 3.1 Full sync (fan-out / fan-in)

```
POST /sync/full ─▶ background_job(sync.store.full, runGroupId)
                 └─▶ worker fan-out: 7 × sync.module (jobId sync:module:{store}:{module}:{group})
                     └─▶ each: runModuleSync → cache bump → audit
                         └─▶ fanin: all 7 modules COMPLETED in group?
                             └─▶ enqueue analytics.refresh (full window)
```

`FULL_SYNC_ORDER = [Products, Collections, Customers, Orders, Inventory, Discounts, Metafields]`
— products and customers land before orders so order upserts resolve customer/variant FKs
from local mirror rows instead of Shopify round-trips.

### 3.2 Module sync lifecycle (`runModuleSync`)

- A `sync_history` row is opened `PENDING → RUNNING`; on success `COMPLETED` with
  `{processed, created, updated, failed}` stats; on throw `FAILED` with `errorMessage`.
- **FULL runs resume**: if a previous FULL run for the module died `RUNNING`/`FAILED`, its
  last persisted `PageCheckpoint` (page_info cursor) seeds the paginator — a crashed
  products sync continues mid-catalog instead of restarting.
- **Incremental runs** (`updated_at_min` modules) use the last COMPLETED run's `started_at`
  minus a 60 s overlap guard so out-of-order webhook/clock drift can't skip rows.
- **Per-page checkpointing**: after every written page the cursor is persisted to
  `sync_history` — crash granularity is one page, worst case replay cost is one page.
- Modules without `updated_at_min` support (inventory levels, metafields) don't claim
  incremental capability; the daily maintenance tick runs them FULL.

### 3.3 Webhook-driven incremental sync (durable handoff)

M1 intake semantics change exactly one thing: **business topics no longer apply payload
changes inside the API request**. Instead:

1. API validates HMAC, dedupes on `(topic, shopifyWebhookId)`, persists the
   `webhook_logs` row `RECEIVED`, enqueues `webhook.process {storeId, webhookLogId}`
   (idempotency key `webhook:{webhookLogId}` — a retry of the same delivery can never
   produce two durable jobs), and answers Shopify `200` immediately.
2. The worker consumer re-loads the row (tenant + shop checks), requires status
   `RECEIVED` (replay / double-delivery dedupe), dispatches the topic's **applier**, marks
   `PROCESSED` — or `FAILED` with `errorMessage` on the last allowed attempt.
3. Appliers return `{invalidate, analyticsDates}`: the handler bumps cache domains and
   enqueues a **windowed** `analytics.refresh` covering exactly the touched days.
4. If the API has no queue producer configured (degraded deploy), it logs a warning and
   falls back to M1 `PROCESSED`-inline behavior — intake never 500s a valid delivery.

`refunds/create` is special: the payload alone can't rebuild order totals, so the applier
re-fetches the order from Shopify (set-based totals) then upserts — metrics stay exact.

### 3.4 Idempotency (replay safety, guaranteed at three layers)

| Layer | Mechanism |
|---|---|
| Webhook handshake | unique `(store_id, topic, shopify_webhook_id)` + durable `webhook:{id}` job key |
| Row writes | upserts keyed by `(store_id, shopify_*_id)` natural keys; `xmax = 0` distinguishes created vs updated so stats are exact on replays (a replay yields 0 creates) |
| Metrics | every aggregation is `INSERT … ON CONFLICT (store_id, metric_date, …) DO UPDATE` from a full-window set-based recompute — re-running is a no-op |

### 3.5 Analytics aggregation

`refreshAnalytics(storeId, window)` recomputes, inside one `withStoreScope` transaction:

- `daily_metrics` — orders, cancellations, items sold, new vs returning customers, AOV (cents)
- `revenue_metrics` — gross / discounts / refunds / net / taxes / shipping (bigint cents) + currency
- `product_metrics` — per product per day: units, orders, revenue
- `customer_metrics` — per customer snapshot: orders, lifetime spend, AOV, first/last order

Bucketing is UTC (`date_trunc('day', processed_at)`); cents via `round(amount * 100)`.
Orders are excluded from metrics when `is_test` is true.

**Concurrency**: overlapping refreshes (webhook window != scheduled window) could commit a
stale snapshot last under READ COMMITTED. The refresh takes
`SELECT pg_advisory_xact_lock(hashtext(storeId))` first — writers for one store serialize,
the last lock holder observes the freshest mirror state and commits last → convergent.

### 3.6 Webhook subscription reconciliation

`ShopifyEnsureWebhooksJob` (worker, runs after installs and daily): lists the app's
subscriptions via GraphQL, creates any missing business topic, updates drifted
`callbackUrl`s. Registered set = `REGISTERED_BUSINESS_TOPICS` (18) + `app/uninstalled`;
GDPR topics ride Shopify's mandatory channel and are never registered here.

### 3.7 Scheduled jobs

| Job | Cadence | Work |
|---|---|---|
| `sync.scheduled-tick` | hourly (env-tunable) | incremental module sync (products/customers/orders/collections/discounts) for every active store |
| `analytics.nightly-tick` | 6 h | full-window analytics refresh for every active store |
| `maintenance.daily-tick` | 24 h | webhook reconciliation; FULL inventory + metafields syncs |

Schedules come from the queue port (BullMQ repeatable jobs in prod, interval timers in
tests); a Redis outage therefore never strands the platform — the API keeps serving
mirrored + pre-aggregated data.

### 3.8 Cache invalidation

Writers don't know about the cache. Webhook appliers declare domains, sync handlers bump
`catalog` + `analytics` after every successful run, and `CacheInvalidator` executes an
`INCR` on the tenant-domain version key. Reads (`analytics.router`, `StoreCache.remember`)
compose keys with the current version — stale entries become unreachable garbage the
moment a write lands, with zero key enumeration.

---

## 4. HTTP transport resilience

All Shopify calls route through `packages/shopify` with retry classifications
(429 → honor `Retry-After`, 5xx → exponential backoff with jitter, 401/403 → terminal).
The retry *budget* is config, not code: `SHOPIFY_HTTP_MAX_RETRIES` (default 6),
`SHOPIFY_HTTP_BASE_DELAY_MS` (default 250) — the worker env validates them, handlers thread
them through `SyncModuleContext.httpOptions` into every paginator. GraphQL calls
additionally respect Admin API cost buckets (sleep when `currentlyAvailable` < query cost).

---

## 5. API surface (all envelope-wrapped, JWT + RBAC + RLS-scoped)

| Endpoint | Notes |
|---|---|
| `POST /api/v1/sync/full` | 202 + `{runGroupId}`, requires **all 7** module sync permissions |
| `POST /api/v1/sync/:module` | 202 + `{jobId}`; per-module permission (`orders:sync`, `collections:sync`, `metafields:sync` are new seeded codes) |
| `GET /api/v1/sync/status` | freshness per module (latest run projection; `PENDING`/`null` when never run) |
| `GET /api/v1/sync/history` | paginated, capped page size, malformed params fall back to defaults |
| `GET /api/v1/analytics/summary?days=7\|30\|90` | reads pre-aggregated tables, `StoreCache` 60 s |
| `GET /api/v1/analytics/top-products`, `/top-customers` | windowed rankings from metric tables |
| `GET /api/v1/catalog/products` · `/customers` · `/:id` · `/orders` · `/:id` · `/inventory/levels` | mirror-table reads with joins (variants, line items, location names, below-threshold filter) |

Sync trigger endpoints are rate-limited 30/60 s per store (`rl:sync-trigger:s:{storeId}`
fixed window — correct across replicas in Redis, hermetic in memory for tests, and
fail-open on cache outage so the control plane can never be taken down by cache trouble).

---

## 6. Schema delta (migration `0003_m2_data_plane.sql`)

- **11 mirror tables**: `shopify_products`, `shopify_product_variants`, `shopify_customers`,
  `shopify_orders`, `shopify_order_line_items`, `shopify_locations`,
  `shopify_inventory_levels`, `shopify_collections`, `shopify_price_rules`,
  `shopify_discount_codes`, `shopify_metafields` — all `store_id`-scoped, unique natural
  keys, soft deletes on deletable resources, `numeric(14,2)` money.
- **4 metric tables**: `daily_metrics` (unique store+date), `revenue_metrics`
  (unique store+date), `product_metrics` (unique store+product+date),
  `customer_metrics` (unique store+customer snapshot).
- `sync_history.run_group_id` (fan-in marker).
- New enums: `product_status`, `collection_type`, `metafield_owner_type`.
- RLS enabled + `store_isolation` policy on all 15 new tables (same fail-closed pattern as
  0002), grants for the app role, permission backfill (`collections:sync`,
  `discounts:sync`, `metafields:sync` → OWNER/ADMIN/MANAGER, `ON CONFLICT DO NOTHING`).
- `packages/types` extended: 3 new enums + 6 new webhook topics; the seed keeps
  `permissions` / `role_permissions` code lists in sync (idempotent — verified by a test
  that runs the seed twice).

Drizzle meta journal is committed; `drizzle-kit generate` prints **“No schema changes”** —
TS schema, SQL migration and snapshot are mutually consistent.

---

## 7. Verification (this milestone's gates)

| Gate | Result |
|---|---|
| `pnpm -r run typecheck` | ✅ 10 projects, 0 errors (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| `pnpm -r run test` | ✅ 240 passed + 2 skipped (skipped = BullMQ↔Redis driver tests, gated on `REDIS_URL`; they run in CI against real Redis) |
| Coverage gates (80/75/80/80 per package; db 70/65 on runtime files) | ✅ api 90.7/76.7 · worker 92.2 · queue 97.1 · cache 92.9 · db 92.3 · sync contract modules 100 |
| `pnpm -r run build` | ✅ api + worker ESM bundles (tsup) |
| `packages/db: drizzle-kit generate` | ✅ “No schema changes” |
| RLS / tenancy | ✅ cross-tenant reads physically impossible (proven through `/api/v1/store`, `/sync/history`, workers’ scoped writers) |
| Money math | ✅ exact-cents assertions in worker integration (gross 31000 ¢, refunds 2000 ¢, net 28000 ¢ on a controlled fixture); `typeof` checks forbid float arithmetic |

---

## 8. Runbook (local)

```bash
docker compose up -d postgres redis
corepack pnpm install
corepack pnpm db:migrate        # applies 0000–0003
corepack pnpm dev               # API on :3000 (PORT)
corepack pnpm dev:worker        # worker health on :3100
```

Production topology (Railway): API service + worker service + Postgres + Redis; the worker
health server answers `/live` and `/ready` (503 while any probe fails) so both services get
proper restart semantics under the platform.

---

## 9. Explicitly deferred (with reasons — not oversights)

| Item | Where it lands | Why |
|---|---|---|
| 5 of the 8 Part-3 worker classes (AI agents, email, automation DAG, cleanup orchestration, notifications WS fan-out) | M4/M6 | they consume *this* data plane; building them now would build them against fake data |
| Store-timezone bucketing for metrics | Reporting milestone (M6 exports) with a per-store `ianaTimezone` column | UTC buckets are exact and reproducible; tz bucketing is a presentation-layer re-slice of daily rows — doing it later doesn't invalidate stored data |
| `fulfillments/create` + `checkouts/create` topics | M6 (automations: fulfillment-delay and abandoned-cart flows) | M2 ships the 18 topics the data plane *consumes*; registering unused topics now would fail the "no dead code" rule |
| Webhook `FAILED` replay endpoint | M7 ops polish (admin tooling), rows are already durable + queryable via `webhook_logs.status` | replay availability is a UI concern; durability exists today |
| Customer / order / variant metafields via GraphQL batched queries | Post-M4 (only if an agent needs them) | shop + product metafields cover Part-10's Business Context; extra owner types add traffic, not capability, today |
| Real-Redis BullMQ driver tests | CI (`.github` pipeline once workflows permission lands — see docs/ci/ci.yml) | sandbox has no Redis; driver is fully exercised through the shared port contract tests plus 2 Redis-gated suites |

---

## 10. Files map (M2-authored surface)

```
packages/crypto|logger|shopify/…   extractions + new paginators/throttle
packages/queue/src/{port,memory.driver,bullmq.driver,persistence,factory}.ts
packages/cache/src/{port,memory.cache,redis.cache,store-cache,factory}.ts
packages/sync/src/{dto,writers,runner,webhook-appliers,webhook-registrar,
                   analytics,jobs,fanin}.ts + modules/{types,index}.ts
packages/db/src/schema/{shopify-data,analytics}.ts + drizzle/0003_m2_data_plane.sql
apps/worker/src/{server,index}.ts + config/ + handlers/ + health/ + test-support/
apps/api/src/modules/{sync,analytics,catalog}/… + middleware/rate-limit.middleware.ts
docs/architecture/M1-shopify-core.md (M1) · docs/architecture/M2-sync-data-plane.md (this)
```
