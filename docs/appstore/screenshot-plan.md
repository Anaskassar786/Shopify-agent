# Screenshot & Capture Plan — App Store Listing

Owner-action plan for producing **real** screenshots, feature images and the
demo video at submission time. Nothing here is fabricated in the repository:
captures are taken from the app running against a provisioned Shopify dev
store because no other source represents the product honestly (P7: *No
placeholder content*).

## Preconditions (capture rig)

- Shopify dev store with the app installed (Partner Dashboard store, not a
  production shop), seeded with realistic catalogue data: ~30 products, ~40
  customers, ~120 orders over 45 days, a handful of low-stock variants, and
  at least two abandoned checkouts (for the recovery funnel screenshots).
- Production build (`pnpm -r run build`) served by the API (single-origin,
  embedded mode) at the staging `APP_URL` — the exact UI reviewers will see.
- Brand color left at the default `#6D6AF8` (Settings → Branding untouched)
  so captures match the listing's brand masters.
- Capture at 1600×1200 viewport (Shopify's guideline for screenshots), PNG,
  device scaling 1×. Crop to the app frame; never annotate over live data.

## Shot list (each maps to a P7 value proposition)

| # | Surface | State before capture | Value prop demonstrated |
| --- | --- | --- | --- |
| 1 | Dashboard | Sync complete, 45-day range selected | Increase revenue — net revenue, attributed AI revenue, trend |
| 2 | AI Recommendations | 3+ pending recommendations with rationale visible | Explainable AI — rationale, expected impact, confidence |
| 3 | Automation builder | The seeded cart-recovery workflow open on the canvas | Business automation — branches, delays, guardrails |
| 4 | Campaigns | Live email campaign with open/click stats populated | Recover lost sales — real tracking on real sends |
| 5 | Billing | Plan comparison + usage meters mid-trial | Trust — transparent pricing and meters |
| 6 | Audit logs | Filtered to AI actions | Control — every AI action is on the record |
| 7 | Settings → Branding | Color/identity section | White-label readiness |
| 8 | Support | Legal & policies card visible | Compliance — policies one click from the admin |

## Feature image (1200×900, required by the listing builder)

Composition: `docs/appstore/brand/logo-wordmark.svg` master on the `#4338CA`
field, tagline *"Your AI Revenue & Automation Manager for Shopify."*, and a
cropped Dashboard capture (shot 1) as the hero visual — assembled in the
owner's design tool; the SVG masters are the committed source of truth.

## Review checklist mapping

The captures above satisfy the 🟡 rows in `review-checklist.md`
(Screenshots, Feature image). Work through them right before step 5 of the
submission sequence.
