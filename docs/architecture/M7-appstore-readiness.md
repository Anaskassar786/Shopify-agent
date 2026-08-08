# M7 — App Store Readiness

The "ship the app, not just the features" milestone: the surfaces an app
reviewer, a regulator, and a security questionnaire touch, plus the evidence
machinery that must exist before strangers run the software at scale. ROADMAP
row: load+security suites green · legal pages · listing assets · review
checklist (P7) · SOC-2-lite evidence.

## 1. What this milestone delivers

- **Public legal plane** — privacy policy, terms of service, refund policy,
  acceptable use, security, served at `/legal` + `/legal/:slug`, linked in-app.
- **SOC-2-lite access review** — a computed answer to "who can act on any
  store, through what, and which operators touched it", API + console.
- **Consolidated adversarial security suite** — the negatives the happy-path
  suites cannot prove.
- **Executable load suite** — multi-tenant concurrency, webhook flood
  integrity, limiter saturation, p95 budgets (ADR 28).
- **WCAG 2.2 AA gate** — axe-core on the real component trees (ADR 29).
- **App Store pack** — listing copy, review checklist with per-item
  evidence, brand masters, capture/video plans, generated `shopify.app.toml`.
- **Production hardening found by the sweep** — three real fixes (below).

## 2. Architecture

### Legal plane (`apps/api/src/modules/legal`, ADR 25/26)

Content is **typed data, not markup**: each document is a module of
title/slug/version/effectiveAt/sections with an allowlisted token vocabulary
(`{entity}`, `{supportEmail}`, `{appUrl}`). The renderer interpolates BEFORE
escaping (tokens come from env, never from requests), produces self-contained
HTML (inline system-font CSS — zero external requests, CSP-clean), and is
mounted at `/legal` with a dedicated 60/min per-IP fixed-window limiter,
no-cache headers, and 404-for-unknown-slugs (typed JSON, never the SPA
shell). Identity values come from `LEGAL_ENTITY_NAME` + `SUPPORT_EMAIL`
(optional in dev, **production-required** by the env superRefine). Invariants
are tested: ≥5 sections each, exact P7 slug set, no external URLs.

### Access review (`apps/api/src/modules/admin/access-review.service.ts`, ADR 27)

Pure read model over existing tables: store, members with role +
`permissionCount` (subquery over `rolePermissions`, `deletedAt` filtered),
active overrides (`revokedAt IS NULL`), recent operator writes, and step-up
session grants (operator identity + IP). No new tables — evidence computed
from the live RBAC state can never drift from it. The console gained an
**Access review** tab: store picker → roster, live overrides, recent operator
writes, write-authority grants (with explicit error state if the API is
unreachable).

### Security/load/a11y gates (`apps/api/src/security`, `…/load`, `apps/web/src/a11y`)

- Security suite: JWT forgeries (garbage, wrong secret, alg=none, expired,
  wrong audience), payload abuse (typed 400/413), SQL-shaped search input
  (inert + physically tenant-bounded), header/query tenant spoofing,
  platform-admin gate probing, CSP/CORS assertions, uniform envelopes. It
  consolidates, not duplicates: OAuth fraud, webhook HMAC rejection, RLS
  isolation, limiter envelopes stay with their original suites.
- Load suite (ADR 28): in-process parallel HTTP. Multi-tenant burst → each
  bearer receives exactly its own store; duplicate-delivery flood (30
  concurrent identical deliveries) → all acked, exactly one `processed`,
  one intake row, one durable `background_jobs` handoff, zero DLQ; limiter
  burst (70 vs max 60) → ≥10 typed 429s, ≤60 admitted, neighbour identity
  unaffected. p95 budgets asserted per class.
- axe suite (ADR 29): WCAG 2.2 AA on Dashboard, Billing, Support (legal
  card), Exports, and the operator access-review console — zero violations,
  with the two jsdom-unrepresentative rules scoped out and reasons recorded.

### Managed config (`apps/api/src/config/app-manifest.ts`, ADR 30)

`shopify.app.toml` is **generated at deploy**: scopes from the canonical list
(test-pinned to `.env.example`), topics from the webhook registry, API
version from env, URLs from the target `APP_URL`. Runtime registration (M1)
stays authoritative for delivery; the TOML is the declarative parity surface
reviewers inspect. Nothing host- or credential-specific is committed.

## 3. Production bugs found by the M7 sweep (fixed in this milestone)

1. **SPA was unservable in production.** `server.ts` mounted the SPA handler
   AFTER `createApp` whose chain ends in `notFoundMiddleware` — every non-API
   GET (including `/`) would have 404'd JSON; the embedded app would never
   render (an app-review hard fail). M3's unit wiring test used the correct
   order, masking the composition-level mistake. Fix: `AppDeps.spa` is now
   mounted **inside** the chain (after `/api/v1`, before `notFound`), built
   first by the server, with a 6-case wiring regression suite.
2. **Oversized bodies answered 500.** `express.json` rejections (`413` from
   the body parser) fell through to the generic internal-error branch; they
   now map to a typed `PAYLOAD_TOO_LARGE` envelope (proven by an
   over-budget POST in the security suite).
3. **Cache driver leaked on shutdown.** The cache instance was created
   inside router composition and never closed; it is now a composition-root
   singleton (shared by routers, the legal limiter, readiness) and closed
   during graceful shutdown.

Also hardened: `/ready` reports `database`, `cache_queue` and `ai_provider`
(skipped ≠ failing for an intentionally unconfigured AI key), `/live` reports
version + uptime, and the auth credential-exchange routes sit behind a
60/hour per-identity limiter (fail-open, logged, typed 429).

## 4. Verification (this milestone's evidence)

- API: 270 tests green (35 files) — includes legal, access-review, security
  (10), load (3), manifest (7), SPA-wiring (6) suites.
- Web: full suite green incl. axe WCAG 2.2 AA on 5 surfaces; Support legal
  card + fallback copy tests; admin access-review tab tests.
- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
  clean across the workspace; coverage gates per package (80/75/80/80);
  build green; migration drift zero (M7 adds **no** schema changes by ADR 27).

## 5. Deferred (honest list)

- **Screenshots, feature image, demo video** — real captures on a seeded dev
  store; plans: `docs/appstore/screenshot-plan.md`, `demo-video-script.md`.
  Fabricating them would violate the no-placeholder rule, so they are owner
  actions at submission, blocked on nothing else.
- **Review submission itself** (Partner Dashboard form + media upload):
  `docs/appstore/review-checklist.md` gives the sequence.
- **Legal counsel review** of the policy texts (they are production-grade
  and data-practice-accurate; counsel sign-off is a business step).
- **Marketing/docs sites + video tutorials** (P7 marketing section): separate
  properties from the app; first-class post-submission work.
- **CCPA + cookie-consent flows**: documented as not required for the
  embedded surface (no marketing cookies, no data sale) in
  `docs/security/soc2-lite.md`; re-assessed with the marketing site.
- **Maintenance mode + per-merchant feature flags**: M8 scope (kill-switch
  taxonomy beyond current per-capability 503 degradation).
