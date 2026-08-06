# PROFIT TOOL AI — Development Roadmap

> Sequencing principle (P8 + P11 risk-1): **thin vertical slices of the revenue loop first** — the app is installable and functional after every milestone. Maps to spec Phase 1–5.

## Milestone plan

| M | Name | Contains (exit criteria) | Spec phase |
|---|------|--------------------------|------------|
| **M0** | **Foundation** ✅ this session | Monorepo · shared `types` · `db` schema core (iam, merchant, shopify, audit, jobs) · api skeleton (config, logging, envelope, errors, health/live/ready) · CI baseline · unit tests green | P1 |
| **M1** | **Shopify App Core** ✅ | OAuth install flow (single-use state, replay-tested) · session-token login → first-party JWT/refresh rotation (reuse-kill) · AES-256-GCM token storage · webhook endpoint (HMAC, dedupe constraint, `APP_UNINSTALLED` + 3 GDPR handlers live) · uninstall cleanup · RBAC (24 permissions/7 roles seeded) · tenant middleware · PostgreSQL RLS (+policy tests) · 107 tests · `docs/architecture/M1-shopify-core.md` | P1 |
| **M2** | **Sync Engine + Data Plane** ✅ | `apps/worker` (BullMQ/Redis) · `@profit/queue` + `@profit/cache` (port + memory/Redis drivers, durable `background_jobs` mirror) · 7 sync modules w/ page-info checkpoints + crash resume + incremental overlap watermark · durable webhook process pipeline (18 appliers, replay-safe) · subscription reconciliation · tenant-versioned cache invalidation · analytics pre-aggregation (`daily/revenue/product/customer_metrics`, advisory-lock convergent) · `/sync` `/analytics` `/catalog` APIs + trigger rate limiting · 240 tests · `docs/architecture/M2-sync-data-plane.md` | P1 |
| **M3** | **Web Shell + Dashboard** ✅ | `packages/ui` design system (tokens + 14 components + SVG charts, dark default) · `apps/web` embedded shell (App Bridge v4, 15-section registry, lazy routes) · live dashboard + analytics on M2 metrics · catalog/inventory/notifications/audit/billing/settings/support pages · realtime notifications (WS gateway → Redis pub/sub → query invalidation + toasts) · command palette ⌘K + grouped global search · onboarding wizard + trial recovery · 465 workspace tests · `docs/architecture/M3-web-shell-dashboard.md` | P1 |
| **M4** | **AI Revenue Loop v1** (THE money milestone) | AiProvider port + Gemini adapter (structured output) · Business Context Builder · Rule Engine (built-ins) · 5 agents (triage tier) · recommendations + evidence + explainability API/UI · approval state machine · Discount + Email tools via registry · automation v1 (abandoned-cart flow) · attribution v1 | P2 |
| **M5** | **Billing + Growth Engine** | Shopify Billing plans + entitlement/quota gates · trial lifecycle jobs (D0–D3) · ROI/attribution reports · engagement events + activation funnel · Super Admin panel v1 · usage metering surfaced in Billing UI | P2 |
| **M6** | **Automation Center + Campaigns** | Workflow DAG engine + builder UI · Email/SMS centers (templates, A/B, tracking pixel/links) · scheduler (cron) · exports (CSV/XLSX/PDF) · audit log UI · support tickets | P2 |
| **M7** | **App Store Readiness** | Load+security suites green · legal pages · listing assets · review checklist (P7) · SOC-2-lite evidence (audit trails, access reviews) | P1→ship |
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

Risks deliberately retired early: tenant isolation (M1), webhook reliability (M1–M2), hallucination control (M4), AI cost runaway (M4 metering), attribution credibility (M4–M5).
