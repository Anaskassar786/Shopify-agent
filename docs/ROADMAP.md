# PROFIT TOOL AI — Development Roadmap

> Sequencing principle (P8 + P11 risk-1): **thin vertical slices of the revenue loop first** — the app is installable and functional after every milestone. Maps to spec Phase 1–5.

## Milestone plan

| M | Name | Contains (exit criteria) | Spec phase |
|---|------|--------------------------|------------|
| **M0** | **Foundation** ✅ this session | Monorepo · shared `types` · `db` schema core (iam, merchant, shopify, audit, jobs) · api skeleton (config, logging, envelope, errors, health/live/ready) · CI baseline · unit tests green | P1 |
| **M1** | **Shopify App Core** ✅ | OAuth install flow (single-use state, replay-tested) · session-token login → first-party JWT/refresh rotation (reuse-kill) · AES-256-GCM token storage · webhook endpoint (HMAC, dedupe constraint, `APP_UNINSTALLED` + 3 GDPR handlers live) · uninstall cleanup · RBAC (24 permissions/7 roles seeded) · tenant middleware · PostgreSQL RLS (+policy tests) · 107 tests · `docs/architecture/M1-shopify-core.md` | P1 |
| **M2** | **Sync Engine + Data Plane** ✅ | `apps/worker` (BullMQ/Redis) · `@profit/queue` + `@profit/cache` (port + memory/Redis drivers, durable `background_jobs` mirror) · 7 sync modules w/ page-info checkpoints + crash resume + incremental overlap watermark · durable webhook process pipeline (18 appliers, replay-safe) · subscription reconciliation · tenant-versioned cache invalidation · analytics pre-aggregation (`daily/revenue/product/customer_metrics`, advisory-lock convergent) · `/sync` `/analytics` `/catalog` APIs + trigger rate limiting · 240 tests · `docs/architecture/M2-sync-data-plane.md` | P1 |
| **M3** | **Web Shell + Dashboard** ✅ | `packages/ui` design system (tokens + 14 components + SVG charts, dark default) · `apps/web` embedded shell (App Bridge v4, 15-section registry, lazy routes) · live dashboard + analytics on M2 metrics · catalog/inventory/notifications/audit/billing/settings/support pages · realtime notifications (WS gateway → Redis pub/sub → query invalidation + toasts) · command palette ⌘K + grouped global search · onboarding wizard + trial recovery · 465 workspace tests · `docs/architecture/M3-web-shell-dashboard.md` | P1 |
| **M4** | **AI Revenue Loop v1** ✅ | `packages/ai` decision engine: AiProvider port + Gemini adapter (raw fetch, repair pass, micro$ pricing) · Business Context Builder (RLS-scoped, PII-minimized) + deterministic Store Health · Rule Engine (8 catalog rules — numbers never come from the model) · 5 agents (versioned prompt packs, structured JSON) · server-side calibration (confidence caps, priority floor, risk max) · recommendations + immutable evidence + explainability · CAS approval state machine · Discount + Email(SMTP) tools via typed registry · `action_executions` with idempotency + step resume · automation v1 (3 modes, abandoned-cart flow, autopilot dual caps) · attribution v1 (checkout-token → discount-code → customer/window chain) · 8th sync module CHECKOUTS (+2 webhook topics) · AI command center / recommendations / automation web surfaces + dashboard AI card · 597 workspace tests · `docs/architecture/M4-ai-revenue-loop.md` | P2 |
| **M5** | **Billing + Growth Engine** ✅ | `packages/billing` plane: plans + entitlement matrix · Shopify charges w/ preserved-trial activation, live-API callback + daily reconcile (no billing webhooks exist) · unified access gate (API 403s · AI fan-out skip · email preflight terminal-fail) · D0–D3 trial journey + expiry/suspension · convergent usage metering + quota refusals · billing ledger + funnel ledger (partial-unique dedupe) · ROI read-model · Super Admin v1 (key-gated, read-only, cross-tenant) `/admin` console · Billing page v2 · 722 workspace tests · `docs/architecture/M5-billing-growth.md` | P2 |
| **M6** | **Automation Center + Campaigns** ✅ | `packages/automation` plane: workflow DAG engine (server-authoritative validator, immutable versions, delay-parking executor, per-step idempotent ledger) + builder UI (layered canvas, automatic YES/NO branch discipline, lint-gated activate) · 3 trigger kinds (manual/cron-via-worker-tick/webhook events) · email/SMS centers (closed 11-variable template catalog · A/B with merchant-picked winner · sender-appended unsubscribe + suppression ledger) · stateless-HMAC tracking pixel/links (documented threat model) · campaign batching with BullMQ jobId double-send dedupe · zero-dep CSV/XLSX/PDF exports (50k cap, one-click audit-log export) · support tickets (merchant + operator inbox) · admin v2: 15-min step-up sessions + write actions (ticket replies, trial extensions, access overrides) + operator action log · 974 tests · `docs/architecture/M6-automation-campaigns.md` | P2 |
| **M7** | **App Store Readiness** ✅ | Public legal plane (`/legal/*` typed content, prod-required `SUPPORT_EMAIL`+`LEGAL_ENTITY_NAME`) · SOC-2-lite access review (read model over RBAC/override/operator ledgers, admin API + console tab) · consolidated adversarial security suite (JWT forgeries, payload abuse, SQLi-shaped input, tenant/admin-gate probing, CSP/CORS) · in-process load suite (tenant burst isolation, duplicate-delivery flood → one durable handoff in ack budget, limiter saturation) · axe WCAG 2.2 AA gate (5 surfaces, zero violations) · generated `shopify.app.toml` (registry/scope parity) · listing pack + review checklist + brand masters + capture/video plans · auth brute-force limiter · prod fixes: SPA serving order + typed 413 + cache-driver lifecycle · runbooks + CHANGELOG, product version 1.0.0 | P1→ship |
| **M8+** | **Phase 3–5** | AI Copilot (chat over tool registry) · multi-agent expansion · forecasting models · enterprise reporting · public API + OpenAPI · white label · mobile apps | P3–P5 |

## Dependency graph (critical path)

```
M0 ──→ M1 ──→ M2 ──→ M4 ──→ M7
        │      └────→ M3 ──→ M4
        └──────────→ M5 (needs tenant+plans from M0/M1)
M4 ──→ M6 (automation engine from M4 hardens into DAG)
```

## What is built FIRST and why (the answer to "build-first")

**Build order within the critical path: M0 → M1 → M2 → (M3 ∥) → M4.**

1. **M0 Foundation first** because every later module consumes the envelope/error/tenant/logging contracts; changing them later violates "never rewrite working modules."
2. **M1 Shopify Core second** because OAuth, session tokens, webhooks, and uninstall cleanup are the *app-review gate* — nothing else is demoable to a real merchant or reviewable by Shopify without it. It also proves the hardest security invariants (I2) early, when cheap.
3. **M2 Sync third** because the AI is only as good as its data plane; the Part 10 Business Context Builder needs real, fresh, queryable data.
4. **M4 (AI loop) before M5 billing polish** per P11 risk #1/#2: the business only works if recommendations demonstrably recover revenue; we must measure that before scaling paywalls. Billing enables revenue capture the moment value is proven — ship M4 with plans enforced but self-serve checkout finished in M5.

Risks deliberately retired early: tenant isolation (M1), webhook reliability (M1–M2), hallucination control (M4 ✅ — deterministic-numbers design, see M4 doc §3), AI cost runaway (M4 ✅ — per-call micro$ metering + per-run call cap), attribution credibility (M4 attribution chain shipped; conviction labeling + ROI reporting polish complete in M5).
