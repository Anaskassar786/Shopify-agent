# PROFIT TOOL AI — Risk & Dependency Register

## External dependencies

| Dependency | Purpose | Tier | Failure mode / mitigation |
|---|---|---|---|
| Shopify Admin API (GraphQL+REST), OAuth, Billing, Webhooks | Core integration | Critical | Rate-limit aware client (cost bucket, backoff, circuit breaker); sync engine tolerates outage; webhooks replayed |
| Google Gemini API | Primary AI provider | High | Adapter isolation → fallback provider per I-failsafe (P5/P12); degrade to rule-only recommendations + merchant notice; cost circuit breaker per store |
| Railway (PG, Redis, compute) | Hosting | High | Cloud-agnostic constraint (P5); PG backups+PITR; stateless api/worker restart-safe |
| Redis | Queue, cache, rate limit, pub/sub | High | Queue persistent (BullMQ); cache miss = recompute; API degrades, doesn't die |
| SMTP / transactional email provider | Email sending | Medium | `EmailProvider` port; worker pauses w/ DLQ + alert, rest of app unaffected (P5 continuity) |
| S3-compatible storage | Exports, reports | Low | Signed-URL port; regeneration on demand |
| (optional) Sentry | Error monitoring | Low | No-op adapter when DSN absent |

## Technical risks (probability × impact → mitigation)

1. **Tenant data leak (L×C) — catastrophic.** Mitigations: m:n identity model, repo auto-scoping, RLS backstop, permission-escalation test suite in CI, cross-tenant fuzz tests on list endpoints.
2. **AI hallucinated actions (M×C) — structurally mitigated at M4.** Numbers (money/counts/subjects) are computed only by the deterministic rule catalog + context builder — the model schema carries no money fields; unknown subject references are dropped; confidence is re-calibrated server-side with data-size caps; priority has a rule floor/+1 cap and CRITICAL only from rules; `finalRisk = max(model, rule)`; action whitelist; CAS approval state machine (`PENDING_APPROVAL` default); immutable per-creation evidence + full `ai_call_logs` forensics (I3/I4). Prompt-instruction guardrails remain a backing layer, not the primary defense.
3. **AI cost runaway (M×H) — metering + hard cap live at M4, entitlement gates live at M5.** Pre-aggregated PII-minimized context; one paid call per agent/firing-batch; `AI_MAX_AGENT_CALLS_PER_RUN` circuit breaker (default 5); per-call `ai_call_logs` micro$ cost recording; M5 adds the revenue gate: blocked stores' *scheduled* runs fan out zero jobs (the model bill for non-paying stores is structurally $0), quota refusals are typed (UPGRADE_REQUIRED/QUOTA_EXCEEDED) with upgrade CTAs instead of silent failure.
4. **Attribution credibility (M×H) — chain shipped at M4, ROI read-model landed at M5.** Attribution joins by strongest signal first (checkout-token → discount-code containment → customer+window) with per-match conviction recorded; the M5 ROI report presents measured attribution ÷ metered AI cost with null-not-Infinity math and *modeled* labels at the edge; merchants see methodology text in the UI; before/after cohort comparisons remain deferred to growth-analytics v2 (P11 risk 2 — single-store proof exists today, fleet cohorts do not).
5. **Webhook storms (H×M).** Ack<5s, enqueue, idempotent upserts, dedupe on `(topic, shopify_webhook_id)` + durable `webhook:{logId}` job keys, BullMQ concurrency caps, DLQ + replay tooling. *(M2 delivered: durable handoff — intake only persists+enqueues; processing is retry-bounded worker work with `RECEIVED`-only dedupe guard.)*
6. **Shopify rate limits at 1k+ stores (M×M).** Per-store token bucket, bulk operations for initial sync, cursor checkpoints, prioritized queues. *(M2 delivered: REST paginator with 429/Retry-After backoff + cost-aware GraphQL paginator that sleeps below bucket threshold; retry budget is env-tunable.)*
6a. **WS fan-out correctness at scale (L×H) — mitigated at M3.** Per-tenant channels (`rt:{storeId}`) subscribed AFTER JWT verification on upgrade; heartbeat + idempotent close; events validated against the shared `isRealtimeEvent` guard before any client-side action; at-most-once delivery documented (client re-pulls via invalidation, so a dropped event only delays a refetch — state converges via the 30s stale + focus-refetch web defaults).
6b. **Embedded runtime supply-chain: App Bridge CDN script (L×H).** Official Shopify CDN pinned path; CSP limits `script-src` to `cdn.shopify.com` + self; the API injects the API key at serve time so the static bundle stays environment-agnostic. iframe embedding restricted via `frame-ancestors admin.shopify.com https://*.myshopify.com`.
6c. **M3 dashboard honesty constraint (process).** P9's profit/AI-score/AI-insights widgets required data that did not exist until M4. M4 delivered the AI score (deterministic Store Health gauge), AI insights card (top open recommendations + run CTA) and automation outcomes tiles directly on the dashboard. Still deferred: → **profit card (needs COGS source decision by M6)** — the only remaining member of the set; it cannot ship until a COGS source is decided, and it stays quarantined here so it cannot silently linger.
7. **Durable "wait 24h" workflow steps (M×M).** Step-state in DB, delayed jobs with idempotency keys, restart-resume tests. *(M4 delivered for single-action executions: `action_executions` per-step checkpoint rows + unique idempotency keys + resume-verified integration tests; the abandoned-cart delay is enforced as policy-hours over real checkout data, not a sleeping job; full DAG waits → M6.)*
8. **Migration failure in prod (L×H).** Expand/contract pattern, migration verified on staging, backup-before-migrate runbook, rollback = previous image + compatible schema.
9. **Email deliverability/compliance (M×M).** Tracking endpoints provider-neutral, unsubscribe + CAN-SPAM enforced in Email Center, domain auth doc (SPF/DKIM/DMARC) in ops runbook.
10. **Scope creep vs MVP (H×H, business).** Roadmap gates: M7 ship-criteria fixed; Phase 3+ items parked regardless of temptation (P11 risk 1).
11. **PII to AI providers (L×C, compliance).** Context Builder minimization policy; banned fields list enforced in code review + tests; DPA-tracked providers.
12. **Billing drift vs Shopify truth (M×M) — mitigated at M5 by construction.** Shopify pushes no billing webhooks, so the platform never *waits* for truth: charge outcomes are re-read live on the public callback (URL input untrusted), and the daily reconcile sweep settles pending charges (7d stale → declined) and cancels subscriptions whose charge vanished. A missed cycle surfaces as delayed state, never wrong state.
13. **Super Admin surface abuse (L×C).** `/api/v1/admin/*` is read-only, env-key-gated (`X-Platform-Admin-Key`), fully audit-logged, and cross-tenant by *documented* design — the deliberate, minimal exception to tenant scoping. The web console keeps the key in memory only. Write actions are deferred until M6 adds operator identity + step-up auth; do NOT add mutating admin endpoints before that gate.
12. **3-day trial conversion too short (business, flagged not fixed).** Instrument D0–D3 funnel (M5) to produce data for a plan-length decision; plan duration is config, not code.

## Operational blockers (need owner action)
- **CI not yet active on GitHub:** the sandbox GitHub App lacks the `workflows` permission, so `.github/workflows/ci.yml` cannot be pushed from here. The complete pipeline is committed at `docs/ci/ci.yml` — either grant the `workflows` permission in the GitHub connection settings, or add the file as `.github/workflows/ci.yml` manually via the GitHub UI. Until then, the gates run locally (`pnpm -r run typecheck && pnpm -r run test && pnpm -r run build` + `pnpm --filter @profit/db run generate`).

## Open questions → decisions taken (per Part-12 autonomy grant; reversible)
- Queue/cache tech → **Redis+BullMQ** (spec-mandated BullMQ).
- Object storage provider → **S3 interface, provider chosen at deploy** (Railway volumes acceptable for staging only).
- Email provider → **SMTP now; port allows Resend/Postmark later** without touching business logic.
- `orders` is an SQL keyword → physical DDL quotes identifiers via Drizzle; domain naming unchanged.
