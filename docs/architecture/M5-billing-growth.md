# M5 — Billing + Growth Engine

> Status: **shipped on branch** `arena/019fd0a3-shopify-agent` · Migration `0006_m5_billing_growth` · +125 tests (722 workspace total) · This doc is the as-built record (deviations from plan documented per the permanent rules).

M5 turns the platform into a business: Shopify-managed recurring charges, a single entitlement gate that protects every revenue action, the D0–D3 trial journey with expiry + suspension, convergent usage metering, the activation funnel ledger, the honest ROI read-model, and a key-gated read-only Super Admin console.

---

## 1. What merchants get

| Surface | Behavior |
|---|---|
| **Plans** (`GET /billing/plans`) | Active catalog: Starter $29/mo · Growth $79/mo · Professional $249/mo · Enterprise $999/mo (yearly = 10× monthly), trial days per plan (3d, Enterprise 14d), entitlement matrix (capabilities + quotas). Seeded by `seedPlatformCatalogs` (additive upsert; never destructively repopulated). |
| **Trial** (install → D0–D3) | OAuth install provisions a TRIALING row on the default plan **and writes `TRIAL_STARTED` to the billing ledger in the same transaction** — the ledger begins at install, every lifecycle fact is trail-able. Worker `billing.trial-tick` (hourly) sends D1/D2/D3 nudge emails (BSP templates over `usage_records` + open recommendations — real numbers, never marketing filler), transitions fresh-expired trials to `TRIAL_EXPIRED` (+2d grace), and suspends grace-exhausted stores. Nudge sends are deduped by billing-ledger rows so re-runs never double-send. |
| **Subscribe** (`POST /billing/subscribe` → Shopify decision screen) | Server creates the Shopify recurring charge (remaining trial days preserved — Shopify rolls them into the paid period), persists `CHARGE_PENDING`, returns 201 `{confirmationUrl, chargeId}`. The SPA breaks out to the **top window** (`window.open(url, "_top")` — Shopify refuses iframe rendering for the decision screen). |
| **Charge callback** (`GET /billing/callback`, public) | URL input is never trusted: the charge id only *addresses* our pending row; acceptance/decline is **re-read from Shopify's live API** (`resolveChargeOutcome`, source `CALLBACK`). Activated → ACTIVE with `periodEnd = now + preservedTrialDays + 30|365` + `CHARGE_ACCEPTED` ledger + `PAID_SUBSCRIPTION_STARTED` funnel emit + merchant notification. Then 302 → the embedded app at `?billing_state=activated|pending|declined` (toast in the SPA). |
| **Reconcile** (`billing.reconcile-tick`, daily) | Shopify sends **no webhooks for app charges** — the sweep is the convergence mechanism. CHARGE_PENDING rows poll the live API (1-day decision grace, 7-day stale → treated as declined); ACTIVE/PAST_DUE rows whose charge vanished converge to CANCELLED (`CHARGE_RECONCILED`). Stores without a resolvable provider are counted as `skippedNoProvider`, never simulated. |
| **Cancel** (`POST /billing/cancel`) | Cancels the live Shopify charge, transitions CANCELLED with access until `currentPeriodEnd`. |
| **Usage meters** (`GET /billing/overview`) | AI calls, emails sent, SMS sent, automation runs — live per-window `used/limit/percent` from the metering sources + convergent `usage_records` buckets (hourly `billing.usage-rollup-tick`, convergent by `(store, meter, bucketDate)` upsert — re-runs are idempotent). |
| **Entitlement gate** | ONE decision function (`evaluateAccess`) guards every revenue action: manual AI runs and approve/run endpoints (403 `UPGRADE_REQUIRED`), quota checks (`QUOTA_EXCEEDED`), the worker's scheduled-AI fan-out (blocked stores burn **zero** tokens), and the email-execution preflight (terminal FAILED + merchant notification, never a silent retry loop). |
| **ROI** (`GET /analytics/roi?windowDays=30|90`) | Measured attribution (14-day conviction windows) vs metered AI micro$-cost: `roiMultiple` (null — never `Infinity` — when cost is zero), acceptance rate, open-pipeline upside labeled *modeled*. Served uncached: stale numbers erode exactly the trust this block builds. |
| **Funnel** (`engagement_events`) | Activation milestones: STORE_CONNECTED (OAuth) → FIRST_SYNC_COMPLETED (true full-sync fan-in) → FIRST_AI_RUN_COMPLETED (worker, on COMPLETED runs) → FIRST_AI_INSIGHT_VIEWED (SPA) → FIRST_RECOMMENDATION_APPROVED (API) → FIRST_AUTOMATION_ENABLED (API, MANUAL→non-MANUAL) → PAID_SUBSCRIPTION_STARTED (charge callback). Deduped per store by a **partial unique index** — the funnel can never double-count. |
| **Super Admin v1** (`/admin` + `GET /api/v1/admin/*`) | Read-only, key-gated, **cross-tenant by design** (the documented exception): owner dashboard (merchants/subscriptions/modeled MRR+ARR/7d AI spend/queue health), activation funnel with step conversion, merchants table (plan, billing state, attributed revenue, 30d AI cost, last activity — session data folded in at the read-model edge), per-store AI usage. |

---

## 2. Architecture

```
packages/billing/                    NEW — the entire plane, port/adapter by construction
  plans.ts          Catalog seed data + entitlements schema + evaluateAccess
                    (THE gate: TRIALING · CHARGE_PENDING(horizon) · ACTIVE ·
                    PAST_DUE(grace) · CANCELLED(≤periodEnd) ⇒ allowed, rest blocked)
  ports.ts          BillingChargeProvider · TrialMailer · ReconcileProvider — infra edges
  billing.service.ts    Subscription state machine, ledger writer, usage summary,
                        entitlement checks, charge subscribe/cancel/outcome resolution
  trial-lifecycle.service.ts (+trial-templates.ts)  Hourly tick: nudges, expiry, suspension
  usage.service.ts      Convergent per-day-bucket rollup (usage_records upsert by natural key)
  reconcile.service.ts  Daily Shopify-truth sweep
  churn.service.ts      ≥5d-silence detection (sessions folded into lastSeen via read-model
                        union — auth never learns about growth events), 7d nudge cooldown
  engagement.service.ts engagement_events writer/reader + funnel aggregation
  growth-analytics.service.ts  Cross-tenant read-models (owner role, admin-gated callers)
  shopify-billing.provider.ts  THE ONLY file that speaks Shopify's billing vocabulary
                               (AppSubscription GraphQL, wire→domain mapped at the boundary)
  jobs.ts             4 tick job contracts (analytics queue, attempts:1, next tick recovers)

apps/api   /billing (overview·plans·history·subscribe·cancel + PUBLIC callback)
           /engagement/events (whitelist: FIRST_AI_INSIGHT_VIEWED · UPGRADE_VIEWED only)
           /analytics/roi · /admin/* (X-Platform-Admin-Key middleware, audit-logged)
           entitlement.guard (requireMeter middleware → 403 typed refusals)
           oauth install writes TRIAL_STARTED inside the provisioning transaction
apps/worker  billing.handlers.ts — thin wiring over the four engines
           sync/ai handlers emit funnel milestones (guarded: telemetry never breaks pipelines)
           aiNightlyTick: per-store access evaluation before enqueueing model spend
           execution handlers: email preflight → terminal FAILED + notify + ENTITLEMENT_DENIED audit
apps/web   /billing v2 — plan comparison (interval toggle, preserved-trial copy),
           usage meter bars, ledger feed, ROI value block, cancel w/ period-end warning,
           Shopify-invoice link-out, billing_state toasts, subscribe → _top redirect
           upgrade CTAs (UpgradeNotice) on UPGRADE_REQUIRED/QUOTA_EXCEEDED anywhere
           /admin — SEPARATE React tree booted in main.tsx BEFORE any Shopify
           machinery: memory-only key gate (probe-verified), overview/merchants/AI-usage
```

### Subscription state machine

```
                install (tx: row + TRIAL_STARTED ledger)
                  │
             TRIALING ──trialEndsAt──▶ TRIAL_EXPIRED ──graceEndsAt──▶ SUSPENDED
               │  ▲                        │  (grace: read-only + upgrade CTA)
   subscribe   │  │ trial-alive fallback   │ subscribe
               ▼  │ (settleStalePending)   ▼
        CHARGE_PENDING ◀──────────────────┘
          │ live-API decision (CALLBACK bounce or RECONCILE sweep)
          ├─ ACCEPTED/ACTIVE ─▶ ACTIVE ──charge vanished──▶ CANCELLED (access ≤ periodEnd)
          ├─ DECLINED/EXPIRED ─▶ TRIALING (if alive) else TRIAL_EXPIRED
          └─ PENDING >7d ─▶ declined path (stale decision screen)
```

Every transition writes a `billing_events` ledger row **in the same transaction** as the status change — ledger and row can never disagree.

### Entitlement enforcement points (single source: `BillingService.evaluateStoreAccess` + `checkEntitlement`)

| Point | Denial behavior |
|---|---|
| API `POST /recommendations/run`, approve | 403 `UPGRADE_REQUIRED` (SPA renders UpgradeNotice → /billing) |
| Quota-bearing API actions | 403 `QUOTA_EXCEEDED` (with meter/limit/used details) |
| Worker `ai.nightly-tick` fan-out | store skipped, counted in `skippedByPlan` |
| Worker email execution preflight | execution + recommendation terminal FAILED, merchant notified, audit `ENTITLEMENT_DENIED` |
| Churn nudges | stores whose sub blocks revenue actions are excluded (nudging them would lie) |

### Data (migration 0006)

- `usage_records` (unique `(storeId, meter, bucketDate)` — convergent rollup target), `billing_events` (append-only ledger; **supersedes** the `invoices`/`payments` tables the spec sketched — Shopify owns invoicing; the platform owns the event trail), `engagement_events` with RLS block (owner-role writes bypass like every other plane; reads go through services) and a **partial unique index** on `(storeId, kind) where kind ∈ milestone kinds`.

---

## 3. Key decisions (amendments — logged per the rules)

1. **`billing_events` ledger supersedes `invoices`/`payments`.** Shopify invoices and receipts live in Shopify; duplicating them into the platform adds drift surface with zero decision value. The platform keeps the *causal* trail (who/what/why/when per transition) and links out to Shopify Admin for invoices.
2. **`usage_records` is convergent, not append-only.** One row per `(store, meter, day)`; the hourly rollup upserts. Reads stay O(1) regardless of runtime age, re-runs are free, and late-arriving data just rewrites its bucket.
3. **The provider is a port colocated in `packages/billing`.** `ShopifyBillingProvider` implements `BillingChargeProvider` with an injectable transport (same discipline as M4's Gemini fetch / SMTP transport): unit tests script the wire; the API harness drives a stateful charge fake through the real endpoints.
4. **`X-Platform-Admin-Key` header, not a user role.** Admin v1 is cross-tenant by definition; putting it behind merchant RBAC would mean minting platform users inside the tenant model. A long random key in env + middleware + full audit trail is the minimal honest boundary. M6 hardens it (operator identity + step-up for the write actions deferred from v1).
5. **Churn detection folds `sessions` into `lastSeen` at the read-model edge.** The engagement ledger can't witness logins (auth predates the ledger and must not learn about growth events); the churn read-model unions `engagement_events.createdAt` with `sessions.createdAt` so "active but quiet installers" are judged on true activity.
6. **`remainingTrialDays` accepts CHARGE_PENDING.** Activation inside the trial carries the preserved days into the paid period; Shopify does the same arithmetic on its side, so the merchant is never double-charged for the trial remainder.
7. **Scheduled-AI gating lives in the worker fan-out, manual gating in the API.** A blocked store's *scheduled* spend is exactly zero; a human explicitly clicking "Run analysis" gets a typed refusal with upgrade copy rather than a silent no-op. Subscription-less stores (only possible for pre-M5-install test stores) are intentionally treated as blocked — production installs always have a trial row, and the M4 worker suite now seeds one accordingly.

## 4. Failure modes handled

- **Callback storms / stale tabs**: `resolveChargeOutcome` is idempotent by status guards; double-decisions no-op.
- **Shopify down at callback**: `BillingUnavailableError` → 503; the reconcile sweep converges later (merchant sees "pending" state).
- **Decision screen abandoned**: pending >1d polled, >7d auto-declined; trial fallback preserves whatever trial life remains.
- **Mailer unconfigured**: nudges/expiry still transition & ledger; sends are counted in `nudgesSkippedNoMailer` (null is a first-class unavailable state, same rule as M4).
- **Email quota at the execution edge**: preflight denial is *terminal* (no retry storm), with merchant notification + audit trail.
- **Duplicate milestone emits**: partial unique index + `ON CONFLICT (with index predicate) DO NOTHING` → `recorded:false`.

## 5. Verification (this milestone's evidence)

| Gate | Result |
|---|---|
| Workspace typecheck | **0 errors**, 15 projects |
| Tests | **722 passed + 4 skipped** (Redis-driver suites self-skip without Redis) — billing pkg 73 · ai 105 (incl. ROI 4) · api 190 (incl. billing 14, engagement 3, admin 6, ROI 3, subscription milestone) · worker 41 (incl. new billing.handlers 7) · web 150 (incl. Billing 7, Admin 5, entitlement/funnel 2) · all M0–M4 suites still green |
| Coverage (gated 80/75/80/80) | billing **99.4/85.3/100/99.4** · logger **100/100/100/100** · api 92.9/76.8/95.6/92.9 · worker 93.3/78.3/95.3/93.3 · web 91.8/83.0/82.4/91.8 · all other gated packages ≥90 stmt |
| Build | `pnpm -r run build` — api + worker tsup, web vite (admin tree in the merchant chunk split; pages stay lazy) |
| Migrations | `pnpm --filter @profit/db run generate` → *"No schema changes"* (0006 committed, applies clean on PGlite + CI Postgres) |

## 6. Deferred (honest list)

- Admin **write actions** (support overrides, trial extensions, refunds) → M6 with operator identity + step-up auth.
- Coupons / discounts / custom plans (`PlanCode.Custom` seat) → when the first enterprise contract needs it.
- Per-seat and per-store quota *enforcement* (meters exist; seats/stores quota reads are live, writers ship with the Team surface).
- Dunning emails beyond the trial journey (card-failure cadence from Shopify charge states) → with the campaigns engine (M6).
- ROI cohort comparisons (before/after install windows across stores) → growth analytics v2.
