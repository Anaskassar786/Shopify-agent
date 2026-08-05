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
2. **AI hallucinated actions (M×C).** Structured-output + Zod + DB cross-check validator; action whitelist; approval state machine; `PENDING_APPROVAL` default; full `ai_call_logs` forensics (I3/I4).
3. **AI cost runaway (M×H).** Model tiers, pre-aggregated context, context cache, debounced triggers, per-store budgets → entitlements; per-call cost logging with alerting (P11 risk 3).
4. **Attribution credibility (M×H).** Modeled estimates labeled; discount/UTM tags preferred; before/after cohort method documented; merchants see methodology (trust feature, P11 risk 2).
5. **Webhook storms (H×M).** Ack<5s, enqueue, idempotent upserts, dedupe on `(topic, shopify_id)`, BullMQ concurrency caps, DLQ + replay tooling.
6. **Shopify rate limits at 1k+ stores (M×M).** Per-store token bucket, bulk operations for initial sync, cursor checkpoints, prioritized queues.
7. **Durable "wait 24h" workflow steps (M×M).** Step-state in DB, delayed jobs with idempotency keys, restart-resume tests.
8. **Migration failure in prod (L×H).** Expand/contract pattern, migration verified on staging, backup-before-migrate runbook, rollback = previous image + compatible schema.
9. **Email deliverability/compliance (M×M).** Tracking endpoints provider-neutral, unsubscribe + CAN-SPAM enforced in Email Center, domain auth doc (SPF/DKIM/DMARC) in ops runbook.
10. **Scope creep vs MVP (H×H, business).** Roadmap gates: M7 ship-criteria fixed; Phase 3+ items parked regardless of temptation (P11 risk 1).
11. **PII to AI providers (L×C, compliance).** Context Builder minimization policy; banned fields list enforced in code review + tests; DPA-tracked providers.
12. **3-day trial conversion too short (business, flagged not fixed).** Instrument D0–D3 funnel (M5) to produce data for a plan-length decision; plan duration is config, not code.

## Operational blockers (need owner action)
- **CI not yet active on GitHub:** the sandbox GitHub App lacks the `workflows` permission, so `.github/workflows/ci.yml` cannot be pushed from here. The complete pipeline is committed at `docs/ci/ci.yml` — either grant the `workflows` permission in the GitHub connection settings, or add the file as `.github/workflows/ci.yml` manually via the GitHub UI. Until then, the gates run locally (`pnpm -r run typecheck && npx vitest run --coverage` in apps/api && `pnpm -r run build`).

## Open questions → decisions taken (per Part-12 autonomy grant; reversible)
- Queue/cache tech → **Redis+BullMQ** (spec-mandated BullMQ).
- Object storage provider → **S3 interface, provider chosen at deploy** (Railway volumes acceptable for staging only).
- Email provider → **SMTP now; port allows Resend/Postmark later** without touching business logic.
- `orders` is an SQL keyword → physical DDL quotes identifiers via Drizzle; domain naming unchanged.
