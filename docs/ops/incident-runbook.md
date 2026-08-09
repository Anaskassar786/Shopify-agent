# Incident Runbook

Scope-capped, hands-on: detection → classification → mitigation → evidence →
review. Uses only surfaces that exist in the codebase today.

## Detection sources

- **Health probes**: `/live` (liveness, version + uptime) and `/ready`
  (component checks: `database`, `cache_queue`, `ai_provider`, `shopify`;
  the configuration checks report `skipped` when unconfigured and never
  hard-gate; the connectivity probes do). Wire these to the platform's
  monitoring (Railway health checks / uptime probe).
- **Error capture (ADR 38, 1.1.1)**: when `SENTRY_DSN` is set, every 5xx and
  process-level exception lands in Sentry (`packages/monitoring` real
  adapter); without it the structured pino logs remain the channel by
  documented design.
- **Job queue ops view (1.1.1)**: `GET /api/v1/admin/ops/jobs` reads the
  durable `background_jobs` mirror (queued/running/completed/failed/retries/
  DLQ per queue) — truthful even with Redis down; also rendered in the admin
  console's Ops tab.
- **Dead letters**: `failed_jobs` growth — every unhandled job, all retries
  exhausted, lands here with error + stack. The load suite asserts zero DLQ
  rows on the happy path; any growth is signal, not noise.
- **Security audit signals**: `shopify.webhook.hmac_rejected`,
  `webhook.unknown_store`, and rate-limit rows in `audit_logs`
  (all emitted by first-party services when they occur).
- **Merchant reports**: support tickets (operator inbox, cross-tenant),
  error ids from the web UI (1:1 with structured pino log lines).

## Classification

| Class | Meaning | Response |
| --- | --- | --- |
| SEV-1 | Tenant data exposure risk, auth bypass, data loss | Stop rollout → mitigate immediately → full evidence capture |
| SEV-2 | Function unavailable for a segment (billing, webhooks, AI) | Triage same-day; operator inbox profile |
| SEV-3 | Degraded but functional (slow syncs, retries consuming quota) | Backlog with evidence link |

## Mitigation playbook (real levers)

- **Poison webhooks / failing syncs**: durable processing already isolates
  failures to DLQ with retries exhausted — replay tooling operates on
  `failed_jobs` rows; do NOT ack-and-forget in code.
- **Auth anoms**: refresh rotation with reuse detection burns stolen
  refresh tokens; revoking a session is a server-side delete (sessions table
  is the only JWT-adjacent state); access overrides are time-boxed by
  schema (`accessUntil` required), so temporary grants self-extinguish.
- **Operator mistakes**: every admin write requires the 15-minute step-up
  session and lands in `platform_admin_actions` with reasoning — rollback ==
  reverse action, itself ledgered.
- **Outage containment**: per-capability failures degrade (`503` typed) —
  billing without provider, tracking without secret, admin without key —
  instead of taking the whole app down. This is by design; don't paper over
  it.
- **Maintenance mode (ADR 37, 1.1.1)**: `PATCH /api/v1/admin/ops/maintenance`
  (step-up) pauses the merchant data-plane on the NEXT request — typed 503
  `MAINTENANCE_MODE` with the operator message, merchant UI shows a calm
  surface, and webhooks/session-boot/legal/OAuth/admin stay up. Use it for
  risky migrations and platform-level incidents; lifting is the same write.
- **Per-merchant containment (ADR 37, 1.1.1)**:
  `PATCH /api/v1/admin/merchants/:storeId/feature-flags` — `aiDisabled`
  stops provider-crossing writes (manual runs + copilot asks),
  `automationDisabled` stops workflow mutations AND new run-starts at the
  worker funnel (in-flight runs finish; the schedule cursor still advances
  honestly). Reads never gate: a contained store loses no visibility.

## Evidence & review

1. Snapshot evidence while mitigating: the relevant `audit_logs` range,
   `platform_admin_actions` rows around the window, `failed_jobs` if
   applicable — all exportable (audit CSV/PDF on the merchant side; admin
   JSON read models for operator data).
2. Post-incident: file the findings; if the fix ships, it goes through the
   normal PR gates (no hot-deploy shortcuts — see
   `docs/ops/change-management.md`).
3. Every incident asks the RISKS question: does `docs/RISKS.md` need a new
   entry or a mitigation note? Update it in the same change.
