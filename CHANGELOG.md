# Changelog

All notable changes to PROFIT TOOL AI. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
milestone-scoped releases (one commit per milestone — see git history).

## [1.1.1] — 2026-08-08 — Launch readiness (hardening)

Production-preparation pass over the shipped M0–M8 surface. No merchant-facing
features, no roadmap movement — operational controls, monitoring truth,
readiness completeness, dead-config retirement, and the missing runbooks.
Architecture decisions: ADR 37 (ops control plane), ADR 38 (error capture),
ADR 39 (webhook-secret consolidation).

### Added

- **Maintenance mode** — `platform_flags` kv table (migration `0009`),
  `PATCH /api/v1/admin/ops/maintenance` (step-up session + mandatory reason,
  `platform_admin_actions` ledger row), `GET /ops/flags`. Merchant
  data-plane 503s typed `MAINTENANCE_MODE` with the operator message (or a
  platform default) on the next request; health, `/legal/*`, Shopify
  webhooks + OAuth, session boot (`/api/v1/auth`), tracking links
  (`/api/v1/t`) and `/api/v1/admin` stay up by construction. The merchant
  web shell renders a calm EmptyState ("We'll be right back" + Check again)
  instead of an alarm.
- **Per-merchant feature flags** — the existing
  `store_settings.featureOverrides` jsonb gains real evaluation points
  (closed two-flag taxonomy in `@profit/types`, reader in `@profit/db`):
  - `aiDisabled` → 503 `FEATURE_DISABLED` on `POST /recommendations/run`
    and `POST /copilot/ask`;
  - `automationDisabled` → 503 on every workflow mutation AND on the
    worker run-start funnel (schedule/manual/webhook converge in
    `workflowRunStartHandler`; in-flight runs finish, the schedule cursor
    still CAS-advances).
  - reads are never gated — a disabled feature hides no merchant data.
  Admin API: `GET/PATCH /api/v1/admin/merchants/:storeId/feature-flags`
  (write step-up-gated + audited).
- **Job-queue ops view** — `GET /api/v1/admin/ops/jobs`: zero-filled status
  buckets, per-queue queued/running/failed + attempts (retries),
  failed-last-24h, DLQ count, latest activity — read from the durable
  `background_jobs`/`failed_jobs` mirror, correct with Redis down.
- **Admin console Ops tab** — maintenance card (state badge, provenance,
  message editor, reason, confirm-with-operator modal), per-store feature
  flag editor (merge-safe: save blocked while the store's flags load), and
  the job-queue readout.
- **`@profit/monitoring`** (19th package) — `ErrorMonitor` port +
  `NoopErrorMonitor` + `SentryErrorMonitor`: hand-rolled Sentry envelope
  POST over fetch (DSN-derived ingest URL, `X-Sentry-Auth`, V8→Sentry
  stack frames, 1.5s timeout, zero new runtime dependencies, failures
  swallowed to logs). Wired at both bootstraps (`unhandledRejection`,
  `uncaughtException`) and the express error handler's ≥500 path with
  request/store/user context. Absent `SENTRY_DSN` = documented no-op;
  structured pino logs remain the truth.
- **Readiness: Shopify configuration check** — `/ready` now reports
  `shopify` (ok/skipped) alongside `database`, `cache_queue`,
  `ai_provider`. Configuration checks never hard-gate; connectivity probes
  do.
- **Runbooks** — `docs/ops/launch-readiness.md` (gap analysis: A in-repo,
  B external, C deferred + the complete external setup order),
  `docs/ops/backup-recovery-runbook.md` (targets, custody, restore drill,
  recovery); incident/release runbooks updated for the new probes and
  mitigation levers.

### Removed

- **`WEBHOOK_SECRET`** — dead config from the PRD's generic env list.
  Shopify signs webhook deliveries with the app secret; HMAC verification
  has one source of truth, `SHOPIFY_API_SECRET` (M1 replay suites intact).

### Verification

- 1197 workspace tests green + 4 Redis-gated skips (19 projects, +32):
  API ops end-to-end suite (11), worker enforcement suite (3), monitoring
  unit suite (13), readiness unit additions (1), web maintenance boundary
  + admin Ops-tab flows (+3), axe WCAG 2.2 AA gate extended to the Ops
  surface (now 8 surfaces).
- Typecheck clean (19 projects), build clean, migration drift zero,
  hygiene scan clean (no console.log outside bootstrap/seed, no `any`, no
  TODO/FIXME, no secret-shaped literals, no placeholder production paths).

## [1.1.0] — 2026-08-08 — M8: Phase 3 — AI Copilot · Forecasting · Enterprise Reports

Feature release: the merchant-facing AI conversation surface, method-versioned
forecasting, and the scheduled enterprise-reporting plane.

### Added

- **AI Copilot** — `/copilot` web surface + `POST /api/v1/copilot/ask` +
  conversation list/detail. Closed 10-intent grammar → deterministic,
  evidence-bound answer packs (business context + forecasts + open
  recommendations); answers render FROM evidence. Optional EXECUTIVE-agent
  lead polish via the indexed numeric-slot bridge — business figures never
  cross the provider port, in either direction. RLS-persisted threads with
  per-message intent/pattern audit (ADR 32).
- **`@profit/forecasting`** — deterministic forecasting with stamped methods:
  `revenue.weekly-seasonality.v1` (weekday profile, residual intervals
  widened by horizon, honest null under 14-day history),
  `demand.velocity.v1` (14d/30d blend), `stockout.velocity.v1`
  (days-of-cover), RFM churn risks. `GET /api/v1/analytics/forecasts`
  (ADR 33).
- **`@profit/reporting`** — enterprise reports: closed DAILY/WEEKLY/MONTHLY/
  QUARTERLY periods, convergent `(store, kind, period)` upsert (BUILDING →
  READY|FAILED), deterministic sections + EXECUTIVE summary, paginated PDFs
  via `buildPdfDocument`, byte storage in Postgres with deterministic
  filenames, worker tick (`reporting` queue, `REPORTS_TICK_INTERVAL_MS`,
  default 6h) per `store_settings.report_preferences`, email delivery via
  the M6 SMTP port idempotent per UTC day with typed honesty outcomes,
  in-app System notifications (ADR 34).
- **Two agents** — EXECUTIVE (prose-only, deliberately outside the decision
  run-order) and PRICING (joins the run-order with the 9th rule,
  `pricing.momentum-uplift`, margin arithmetic in the deterministic rule
  layer) (ADR 36).
- **New APIs** — `/api/v1/copilot/*`, `/api/v1/reports/*`,
  `/analytics/forecasts`; RBAC `copilot:read/ask` + `reports:read/manage`
  seeded idempotently (ADR 35); migration `0008` (3 RLS tables,
  `report_preferences` jsonb, enum extensions).
- **Two web surfaces** — Copilot chat (evidence tables, method/confidence
  badges, read-only role handling) and the Report vault (schedule card,
  polling vault, sections drawer, PDF download, email action); both under
  the axe WCAG 2.2 AA gate (now 7 surfaces).

### Verification

- 1165 workspace tests green + 4 Redis-gated skips (18 projects, +133);
  typecheck/build clean; migration drift zero; per-package coverage gates
  green; milestone doc `docs/architecture/M8-phase3-copilot-forecasting-reports.md`.

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
