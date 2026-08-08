# Launch Readiness — PROFIT TOOL AI (1.1.1)

The complete production-preparation pass over the shipped M0–M8 surface.
Scope discipline: **nothing new for merchants** — this pass hardens what
exists (ops controls, monitoring, readiness truth, runbooks, retirement of
dead config) and proves it with tests. No milestones were extended, no
future-phase features were started, no external deployment was performed.

This document is the single map from the ten launch audit areas to shipped
evidence, and splits the gap analysis into:

- **A — completed in this repository** (code + tests + docs),
- **B — external setup required after this** (hosting/dashboard/provider
  configuration only — no code changes),
- **C — not required for current launch** (owner/business actions and
  deferred roadmap items the code cannot and should not do).

## A — Completed in repository (1.1.1)

### 1. Ops control plane (ADR 37) — the PRD Part-5 ops switches, delivered

| Requirement | Shipped |
|---|---|
| Maintenance mode: enable · disable · custom message | `platform_flags` kv table (migration `0009`), `OpsFlagsService`, `PATCH /api/v1/admin/ops/maintenance` (step-up + reason mandatory), default message constant |
| Admin bypass | `/api/v1/admin/*` mounts BEFORE the guard; the console's Ops tab is the control room during an incident |
| Merchant-plane behavior | Every `/api/v1` data router 503s `MAINTENANCE_MODE` + operator message on the NEXT request; web (`QueryBoundary`) renders a calm "We'll be right back" surface with a manual Check-again — no alarm, no error id |
| Exempt by construction | `/live` `/ready` `/health`, `/legal/*`, `/shopify/*` (webhooks keep acking into durable intake; OAuth install stays open), `/api/v1/auth` (session boot), `/api/v1/t` (links already in sent emails) |
| Per-merchant feature flags | Existing `store_settings.featureOverrides` jsonb gains real evaluation points: `aiDisabled` → 503 on `POST /recommendations/run` + `POST /copilot/ask`; `automationDisabled` → 503 on all workflow mutations (create/update/activate/pause/archive/run) AND the worker run-start funnel (schedule/manual/webhook all converge in `workflowRunStartHandler`; in-flight runs finish; the schedule cursor still CAS-advances honestly) |
| Reads never gate | Dashboards, history, run lists stay readable — a disabled feature hides no merchant data |
| Audit | Both writes land in `platform_admin_actions` with operator id, payload hash, IP |
| Job-queue ops monitoring | `GET /api/v1/admin/ops/jobs`: pending/running/completed/failed (+ attempts = retries) per queue from the durable `background_jobs` mirror, failed-last-24h, DLQ count from `failed_jobs`, latest activity — truthful even with Redis down; rendered in the admin console Ops tab |

Tests: `apps/api/src/modules/ops/ops.integration.test.ts` (11) —
end-to-end through the real harness: default-off, step-up 401, engage →
merchant 503 with the message (+ default-message fallback), all exempt
surfaces probed up, disable → recovery, audit rows; feature-flag write
gate checks (step-up/404/400/closed taxonomy), both enforcement points,
reads open, un-flag restores; jobs view buckets.
`apps/worker/src/handlers/ops.integration.test.ts` (3) — disabled store's
run-starts skip without run rows or side effects (manual AND
schedule-fired), clearing restores execution.
`apps/web` — misc suites +14 admin console tests incl. Ops-tab flows
(maintenance PATCH with session header, flag merge PATCH, panel reflects
kv state).

### 2. Error monitoring (ADR 38) — real adapter, not a promise

- `packages/monitoring` (new, 19th package): `ErrorMonitor` port +
  `NoopErrorMonitor` + `SentryErrorMonitor` — hand-rolled Sentry envelope
  transport over `fetch`: DSN-derived ingest URL + `X-Sentry-Auth`,
  V8→Sentry stack-frame mapping, 1.5 s timeout, **zero new runtime
  dependencies**, every failure swallowed into the pino log (monitoring
  must never crash the app). Malformed DSN fails loud at construction.
- Wired at BOTH bootstraps (`unhandledRejection`, `uncaughtException` →
  capture + exit) and the express error handler's ≥500 path with
  request/store/user context. Worker reads its own `SENTRY_DSN` /
  `APP_VERSION`.
- Absent `SENTRY_DSN` ⇒ documented no-op; structured logs stay the truth.
- Tests: 13 unit tests (DSN parse, frame mapping, envelope shape, timeout,
  failure swallowing, factory selection), coverage ≥ 88% branches.

### 3. Readiness truth — the four production signals

`/ready` now probes everything production actually depends on:
`database` (live probe), `cache_queue` (live probe — BullMQ starves
without it), `ai_provider` (configuration truth — a live probe would cost
money per hit), and **new** `shopify` (app-credentials truth: key + secret
+ app URL + scopes all present). Configuration checks report `skipped`
when intentionally unconfigured and never hard-gate; connectivity probes
do gate. Unit tests extended.

### 4. Dead config retired (ADR 39)

`WEBHOOK_SECRET` shipped in the PRD's generic env list but was never
consumed: Shopify signs deliveries with the **app secret**, verified by
`verifyWebhookHmac` + the M1 replay suites. Removed from the env schema
and `.env.example` — one HMAC source of truth (`SHOPIFY_API_SECRET`),
nothing unused left to drift.

### 5. Documentation & version

- This gap analysis + the A/B/C split (this file).
- `docs/ops/backup-recovery-runbook.md` — NEW (was the missing op doc).
- `docs/ops/incident-runbook.md` — new detection sources (Sentry, ops-jobs
  view) + mitigation levers (maintenance mode, per-merchant flags).
- `docs/ops/release-runbook.md` — smoke updated for four readiness checks
  + ops-plane smoke.
- `docs/RISKS.md` — Sentry row now describes the real adapter; risk 21
  records the ops-control-plane blast-radius analysis and closes the M7
  maintenance carry-over.
- `docs/architecture/ARCHITECTURE.md` — ADR 37/38/39.
- Version **1.1.1** (patch — hardening only): root `package.json`,
  `APP_VERSION` default in API + worker env, `.env.example`, CHANGELOG.

## B — External setup required after this (no code changes)

Ordered runbook for the owner; each item maps to config the code already
validates or consumes.

### B1. Railway (or equivalent) — services

1. **PostgreSQL 16** — managed instance; note `DATABASE_URL`.
2. **Redis 7** — managed instance; note `REDIS_URL`.
3. **API service** (Docker or nixpacks from repo root): start
   `apps/api`; health check path `/live`, port 3000.
4. **Worker service**: same build, start `apps/worker`, port 3100,
   health check `/live` (worker health server).
5. Set the variables below per service (API env ∧ worker env as marked in
   `.env.example`).

### B2. Required environment (boot fails loudly without these in production)

| Variable | Service | Where it comes from |
|---|---|---|
| `DATABASE_URL` | both | Railway Postgres |
| `REDIS_URL` | both | Railway Redis |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | API | Partner Dashboard → app → Client credentials |
| `SHOPIFY_APP_URL` | both | `https://<prod-domain>` |
| `SHOPIFY_SCOPES` | API | already pinned in `.env.example` (copy as-is) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | API | `openssl rand -base64 48` (two distinct) |
| `ENCRYPTION_KEY` | both | 32 bytes, hex/base64 (`openssl rand -hex 32`) |
| `PLATFORM_ADMIN_KEY` | API | long random — gates the admin console |
| `SUPPORT_EMAIL` / `LEGAL_ENTITY_NAME` | API | the real support inbox + legal entity (public surfaces) |
| `TRACKING_SIGNING_SECRET` | both, must MATCH | `openssl rand -base64 48` |
| `TRACKING_PUBLIC_BASE_URL` | worker | public API origin |
| `APP_VERSION` | both | `1.1.1` |

Optional-but-expected: `GEMINI_API_KEY` (AI plane; absent = honest
`PROVIDER_UNAVAILABLE` degradations, never a crash), `SMTP_*` + `EMAIL_FROM`
(transactional email; absent = capability-unavailable), `SMS_TWILIO_*`
(absent = SMS sends fail fast with a merchant-readable reason),
`SENTRY_DSN` (error capture; absent = documented no-op),
`SHOPIFY_BILLING_TEST=false` (NEVER true in production).

### B3. Shopify Partner Dashboard

1. App URL `https://<prod-domain>`, allowed redirection URL
   `https://<prod-domain>/shopify/callback`.
2. Render + deploy the managed config for the target host:
   `APP_URL=https://<prod-domain> pnpm --filter @profit/api run manifest:render -- --out shopify.app.toml`
   then `shopify app deploy` (ADR 30). Scopes/GDPR topics derive from the
   repo, so the TOML can never drift from the code.
3. GDPR mandatory webhooks (`customers/data_request`, `customers/redact`,
   `shop/redact`) point at `https://<prod-domain>/shopify/webhooks` — the
   runtime registration (M1) also registers them on install; the TOML
   declares parity for review.
4. Billing: managed pricing / app-subscription config per
   `docs/appstore/review-checklist.md`; `SHOPIFY_BILLING_TEST=false`.

### B4. Providers

- Google AI Studio → `GEMINI_API_KEY` (billing-enabled Gemini project).
- SMTP credentials (transactional provider) — SPF/DKIM/DMARC on the sender
  domain per RISKS #9.
- Twilio (only when SMS launches) — all three `SMS_TWILIO_*` or none.
- Sentry project → `SENTRY_DSN` in both service envs.

### B5. Domain/TLS

Point the public domain at the API service (single origin serves web +
API by contract — ADR: one-origin serving). TLS terminates at the
platform edge; `SHOPIFY_APP_URL` and `APP_URL` must be the https origin.

### B6. Data protection

Enable managed Postgres backups + PITR and run the restore test once
BEFORE App Review — full procedure in
`docs/ops/backup-recovery-runbook.md` (RPO ≤ 24 h snapshots / ≤ 5 min PITR,
restore-drill verified RTO).

### B7. First boot verification

`release-runbook.md` smoke list, then open `/admin` with the platform key
→ Ops tab: flags read `{"maintenance": null}`, jobs buckets render, unlock
a step-up session and dry-run a maintenance enable/disable pair against a
dev store (restore immediately).

## C — Not required for current launch

- **CI activation on GitHub**: `.github/workflows/ci.yml` cannot be pushed
  from the sandbox GitHub App (no `workflows` permission); the complete
  pipeline is committed at `docs/ci/ci.yml` — grant the permission or add
  the file via the GitHub UI (owner action, RISKS operational blockers).
- **App Review submission artifacts**: screenshots, feature image, demo
  video are seeded-capture tasks at submission time
  (`docs/appstore/screenshot-plan.md`, `demo-video-script.md`) — they
  cannot be fabricated in-repo; the submission checklist itself is
  code-complete (`docs/appstore/review-checklist.md`).
- **Post-launch business decisions**: 3-day-trial tuning (RISKS #14),
  COGS source decision for the profit card (RISKS #6c), fleet cohort
  analytics (RISKS #4).
- **Deferred roadmap (explicitly NOT this launch)**: M9+ — public API,
  white label, mobile, enterprise integrations, Phase 4/5 features.
  None were started; the launch pass added zero merchant-facing features.
