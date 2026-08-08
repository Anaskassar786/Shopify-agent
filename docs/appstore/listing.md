# PROFIT TOOL AI — Shopify App Store Listing Content Pack

Single source of truth for the App Store listing copy (P7: APP LISTING ASSETS).
Paste-ready for the Partner Dashboard; every claim maps to a shipped capability
— no placeholder content (P7 rule: "No placeholder content").

---

## Core identity

| Field | Value |
| --- | --- |
| App name | **PROFIT TOOL AI** |
| Tagline | *Your AI Revenue & Automation Manager for Shopify.* (P7 POSITIONING) |
| Category | Store management → Analytics & automation |
| Brand masters | `docs/appstore/brand/app-icon.svg` (1200×1200), `docs/appstore/brand/logo-wordmark.svg` — export PNG at 1200×1200 for the icon field at submission (owner action, see `review-checklist.md`) |

## Short description (≤ 120 characters)

```
AI decision support and revenue automation for Shopify — recovery campaigns, discount intelligence, and automation workflows your data can explain.
```

## Long description (Partner Dashboard "App introduction")

```
PROFIT TOOL AI is an embedded AI revenue and automation manager for Shopify
stores. It reads your store's own orders, products, customers, and inventory,
then turns them into explainable decisions and recoverable revenue — without
leaving your Shopify admin.

RECOVER LOST SALES
• Cart- and browse-recovery email and SMS campaigns with per-template
  send, open, and click tracking, plus unsubscribe safety on every message.
• Automation workflows you build on a visual DAG editor — trigger on store
  events, branch on conditions, and act with guardrailed widgets.

DECIDE WITH NUMBERS, NOT GUESSWORK
• An AI decision engine generates revenue recommendations with rationale,
  expected impact, and confidence — every recommendation is attributable to
  the store data that produced it.
• Discount intelligence, inventory signals, and customer segmentation keep
  pricing, stock, and audiences aligned with profitability.

OPERATE WITH CONTROL
• You stay in the loop: recommendations require approval, automations run
  under per-plan quotas, and every AI or operator action lands in an
  exportable audit trail.
• Built-in billing with Free → Enterprise plans, a free trial on every plan,
  and usage meters you can export at any time.

MULTI-STORE AND TEAM READY
• Role-based access for your team, multi-store support on higher plans, and
  a platform-grade security model (row-level tenant isolation, HMAC-verified
  webhooks, encrypted at rest).

PROFIT TOOL AI is installed in minutes, starts learning from your first sync,
and shows measurable impact on a dashboard built for Shopify merchants.
```

### Value propositions (P7 POSITIONING — used across listing/screenshots/videos)

- Increase revenue
- Recover lost sales
- AI decision support
- Business automation
- Explainable AI

## Keywords (≤ 5, Partner Dashboard)

```
ai, revenue, automation, cart recovery, analytics
```

## SEO metadata

- **Title (≤ 60 chars):** `PROFIT TOOL AI — AI Revenue & Automation Manager`
- **Meta description (≤ 160 chars):** `Embedded AI decision support and revenue automation for Shopify: recovery campaigns, discount intelligence, workflow automation, and explainable analytics.`

## Pricing (must match the seeded catalog — `packages/db/src/seed.ts`)

| Plan | Monthly | Yearly (10× monthly) | Trial |
| --- | --- | --- | --- |
| Starter | $29/mo | $290/yr | 3 days |
| Growth | $79/mo | $790/yr | 3 days |
| Professional | $249/mo | $2,490/yr | 3 days |
| Enterprise | $999/mo | $9,990/yr | 14 days |

Charges run through the Shopify Billing API (managed pricing / app charges),
test-flagged in non-production so buyers are never billed in trials.

## Legal URLs (Partner Dashboard → App setup)

| Field | URL pattern |
| --- | --- |
| Privacy policy | `https://<app-host>/legal/privacy` |
| Terms of service | `https://<app-host>/legal/terms` |
| Refund policy | `https://<app-host>/legal/refunds` |
| Acceptable use | `https://<app-host>/legal/acceptable-use` |
| Security | `https://<app-host>/legal/security` |

`<app-host>` is the production `APP_URL` from the release runbook
(`docs/ops/release-runbook.md`). The support email comes from `SUPPORT_EMAIL`
(configured per environment; rendered into every policy footer).

## Deferred assets (owner actions — tracked in review-checklist.md)

Screenshots, feature images, and the demo video require a provisioned Shopify
dev store with the app installed; they are produced at submission time, never
faked. Everything in this pack that can ship as code or copy is shipped here.
