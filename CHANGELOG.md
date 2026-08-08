# Changelog

All notable changes to PROFIT TOOL AI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
milestone-scoped releases (one commit per milestone — see git history).

## [1.0.0] — 2026-08-08 — M7: App Store Readiness

First production-candidate release: Shopify App Review readiness, public
legal plane, SOC-2-lite evidence, and the consolidated security/load gates.

### Added

- **Public legal plane** — unauthenticated, self-contained policy pages at
  `/legal` (index) and `/legal/{privacy,terms,refunds,acceptable-use,security}`,
  rendered from bundled typed content modules (ADR 25/26): versioned and
  effective-dated, tokens from `LEGAL_ENTITY_NAME`/`SUPPORT_EMAIL` env
  (production-required), dedicated per-IP rate limit, no-cache headers.
- **SOC-2-lite access review** — admin read model over the existing RBAC,
  override and operator ledgers (no new tables, ADR 27):
  `GET /api/v1/admin/access-review?storeId=` and
  `GET /api/v1/admin/access-review/sessions`; "Access review" tab in the
  admin console (member roster with permission breadth, live overrides,
  recent operator writes, write-authority grants).
- **Consolidated security suite** (`apps/api/src/security`) — alg=none /
  wrong-secret / expired / wrong-audience JWT forgery, malformed JSON and
  oversized-body envelopes, SQL-shaped search input with physical tenant
  isolation, header/query tenant-spoof proof, admin-gate probing, CSP/CORS
  assertions, uniform failure envelopes.
- **In-process load suite** (`apps/api/src/load`, ADR 28) — parallel
  multi-tenant reads with hard isolation, duplicate-delivery webhook flood
  deduped to exactly one durable handoff within Shopify's ack budget,
  rate-limit burst saturation with per-identity isolation; p95 budgets.
- **axe WCAG 2.2 AA gate** (`apps/web/src/a11y`, ADR 29) — zero-violation
  runs on Dashboard, Billing, Support (incl. the legal card), Exports, and
  the operator access-review console.
- **Shopify managed-config generator** (ADR 30) — `pnpm --filter @profit/api
  run manifest:render` derives `shopify.app.toml` from the webhook registry,
  canonical scope list and env; parity tests pin registry/scopes/`.env.example`.
- **App Store pack** (`docs/appstore/`) — listing copy (real plan pricing),
  pre-submission review checklist with per-item evidence links, brand SVG
  masters (icon + wordmark), screenshot/capture plan, demo-video script.
- **Ops + compliance docs** — `docs/security/soc2-lite.md`,
  `docs/ops/release-runbook.md`, `docs/ops/incident-runbook.md`,
  `docs/ops/change-management.md`, root `CHANGELOG.md`.
- **Support surface honesty** — the Support page reads the configured
  support mailbox from `GET /api/v1/store` (`supportEmail` field, additive)
  and links every legal page; unconfigured environments show ticket-first
  copy instead of a hardcoded address.
- **Auth exchange brute-force limiter** — 60/hour per identity on
  `/auth/session` + `/auth/refresh`, fail-open on cache errors, typed 429
  envelope.

### Fixed

- **Production SPA serving** — the SPA handler was mounted after the API
  chain ended in `notFound`, so every non-API GET (including `/`, the
  embedded app itself) would have answered 404 JSON in production; the SPA
  is now mounted inside the router chain with a regression suite
  (`spa-wiring.integration.test.ts`).
- **Oversized bodies answered 500** — `express.json` rejections (413) now
  map to the typed `PAYLOAD_TOO_LARGE` envelope (`ErrorCode.PayloadTooLarge`).
- **Cache driver lifecycle** — the cache instance was created inside router
  composition and never closed on shutdown; it is now a composition-root
  singleton shared with readiness probes and closed during graceful shutdown.
- **Readiness depth** — `/ready` now checks `database`, `cache_queue` and
  `ai_provider` (non-gating `skipped` when unconfigured).

## [0.6.0] — 2026-08-07 — M6: Automation Center + Campaigns

- Workflow DAG engine (`packages/automation`): server-authoritative
  validation on save/activate, immutable versions, trigger/condition/wait/
  send-email/send-sms/tag/discount nodes, delay parking with tick-resume,
  per-step idempotent run ledger.
- Builder UI: pure graph-ops module + layered canvas, automatic YES/NO branch
  discipline, lint-gated activate. Trigger kinds: manual, 5-field UTC cron,
  Shopify-webhook events deduped per delivery.
- Email/SMS campaign centers: closed 11-variable template catalog with honest
  409s, A/B variants with merchant-picked winner, sender-appended unsubscribe
  with durable suppression ledger.
- Stateless HMAC tracking pixel/links; campaign batching (50/batch, 2s
  throttle, BullMQ jobId dedupe); zero-dependency CSV/XLSX/PDF exporters
  (50k-row cap); support tickets (merchant workspace + operator inbox).
- Admin v2: 15-minute step-up sessions gate every write; trial extension with
  `TRIAL_EXTENDED` billing event; time-boxed access overrides; operator
  action log. 16-section shell fully live.

## [0.5.0] — 2026-08-06 — M5: Billing + Growth Engine

- Shopify Billing charges with dev-store `test` flag, entitlements, trial
  lifecycle (extend/gap/grace), usage metering caps, reconcile + churn
  computation, funnel events.
- Merchant billing UI (plans, meters, ledger, ROI), admin v1 console
  (cross-tenant overview, merchants, AI usage), growth analytics.

## [0.4.0] — 2026-08-06 — M4: AI Revenue Loop v1

- AI decision engine (`@profit/ai`): provider port + Gemini adapter, context
  builder, rules, calibration, recommendations with rationale; executor +
  attribution v1; autopilot guardrails.

## [0.3.0] — 2026-08-06 — M3: Web Shell + Dashboard

- React 19 SPA: token design system (`@profit/ui`), 15-section shell,
  realtime notifications, audit log view, onboarding wizard, global search,
  real-API dashboard; App Bridge v4 embedded boot with API-injected key.

## [0.2.0] — 2026-08-05 — M2: Sync Engine + Data Plane

- BullMQ workers, 7 sync modules, analytics plane, sync/analytics/catalog
  APIs, durable webhook ingest (`webhook.process` job), DLQ + retries.

## [0.1.0] — 2026-08-05 — M1: Shopify App Core

- OAuth (state + HMAC, replay-proof), session-token auth + JWT rotation with
  reuse detection, HMAC webhooks + GDPR mandatory handlers, RBAC, Postgres
  row-level security, offline tokens encrypted at rest. (M0: monorepo
  scaffold, shared contracts, tenant schema, API skeleton.)
