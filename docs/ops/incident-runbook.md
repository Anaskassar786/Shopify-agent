# Incident Runbook

Scope-capped, hands-on: detection → classification → mitigation → evidence →
review. Uses only surfaces that exist in the codebase today.

## Detection sources

- **Health probes**: `/live` (liveness, version + uptime) and `/ready`
  (component checks: `database`, `cache_queue`, `ai_provider`; the AI check
  reports `skipped` when unconfigured and never hard-gates). Wire these to
  the platform's monitoring (Railway health checks / uptime probe).
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
