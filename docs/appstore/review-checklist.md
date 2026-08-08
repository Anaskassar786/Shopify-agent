# App Review Checklist — pre-submission (P7)

The P7 `APP REVIEW CHECKLIST` line-by-line, with the shipped evidence for each
item and the exact owner actions left before clicking **Submit for review**.
Status: 🟢 shipped & verified · 🟡 requires owner action at submission (never
faked) · ⬜ not started.

## Partner requirement matrix (P7 `APP STORE READINESS`)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Embedded app | 🟢 | App Bridge v4 boot, `apps/web/index.html` (`shopify-api-key` meta injected at serve time by the API static handler) |
| OAuth | 🟢 | `apps/api/src/modules/shopify/oauth.service.ts` + `shopify.router.ts` (`/shopify/install`, `/shopify/callback`); state+HMAC verified, integration-tested in `shopify.integration.test.ts` |
| Session tokens | 🟢 | `apps/api/src/lib/shopify/session-token.ts`; exchanged for platform JWTs in `modules/auth` (rotation + reuse detection, brute-force rate limited, `auth.integration.test.ts`) |
| Billing API | 🟢 | `packages/billing`, `apps/api/src/modules/billing`; dev-store charges carry `test: true` (`SHOPIFY_BILLING_TEST`), trial lifecycle + `billing.integration.test.ts` |
| Webhooks + verification | 🟢 | HMAC-verified intake (`webhook.service.ts` via `@profit/shopify.verifyWebhookHmac`), registry-driven topics, durable DLQ processing, `webhook-service.test.ts` |
| Uninstall cleanup | 🟢 | `handleAppUninstalled` (inline delivery — compliance never waits on a queue) in `webhooks/handlers.ts` |
| GDPR compliance | 🟢 | Mandatory webhooks `customers/data_request`, `customers/redact`, `shop/redact` (inline handlers from day one) + merchant data export/audit download (`exports.router.ts`, `audit.router.ts`) |
| Privacy policy / Terms of service | 🟢 | Bundled legal plane `GET /legal/*` (privacy, terms, refunds, acceptable-use, security), `apps/api/src/modules/legal` |
| Support contact | 🟢 code / 🟡 value | `SUPPORT_EMAIL` env (production-required) rendered into every legal footer + in-app Support page; **owner: set the production mailbox before submission** |
| Performance guidelines | 🟢 | Load suite budgets: `apps/api/src/load/load.suite.test.ts` (p95 + concurrency budgets, in-process per ADR 28) |
| Accessibility guidelines | 🟢 | axe-core WCAG 2.2 AA gate on the real component tree: `apps/web/src/a11y/a11y.suite.test.tsx`, theme-token contrast, lazy routes |

## P7 `APP REVIEW CHECKLIST` verbatim

| Item | Status | Evidence / owner action |
| --- | --- | --- |
| OAuth | 🟢 | see above |
| Billing | 🟢 | see above |
| Embedded | 🟢 | see above |
| Session tokens | 🟢 | see above |
| Webhooks | 🟢 | see above; declarative parity via generated `shopify.app.toml` (ADR 30: `pnpm --filter @profit/api run manifest:render`, registry-derived, `app-manifest.test.ts`) |
| Privacy policy | 🟢 | `/legal/privacy` |
| ToS | 🟢 | `/legal/terms` |
| Support contact | 🟢 code / 🟡 value | set production `SUPPORT_EMAIL` |
| Icons | 🟢 | `docs/appstore/brand/app-icon.svg` master (1200×1200, gradient mark); **owner: export PNG at submission** |
| Screenshots | 🟡 | **Owner action:** capture real screenshots on a provisioned dev store (listing.md defines the value props each shot must demonstrate). Never fabricated. |
| Demo video | 🟡 | **Owner action:** record the install → first sync → first recommendation flow on the dev store. |
| Docs | 🟢 | `docs/` (spec, architecture incl. ADR 25–31, runbook `docs/ops/release-runbook.md`, `CHANGELOG.md`) |
| Uninstall cleanup | 🟢 | see above |
| No placeholder content | 🟢 | legal + listing copy are real and complete; hygiene gates in CI grep for placeholder markers; all copy links resolve |

## Compliance posture (P7 `COMPLIANCE` / `LEGAL PAGES` / `DATA RETENTION RIGHTS`)

- **GDPR** — mandatory webhooks + export + delete shipped (above).
- **CCPA** — documented as not required at launch: the app is embedded in the
  Shopify admin, sets **no first-party marketing cookies**, and does not sell
  merchant/shopper personal information. Revisit when the marketing site
  ships (see `docs/security/soc2-lite.md`).
- **Cookie consent** — not required for the embedded surface (no non-essential
  cookies); consent handling is a marketing-site concern, tracked with CCPA.
- **DPA** — future (enterprise tier), listed as such in `/legal/privacy`.
- **Data retention rights** — export data, delete store/uninstall cleanup,
  download audit logs all live in the product surface.

## Submission sequence (owner)

1. Complete the release-runbook preflight (`docs/ops/release-runbook.md`).
2. Set production `APP_URL`, `SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME`, `SHOPIFY_*`.
3. Render managed config: `pnpm --filter @profit/api run manifest:render -- --out shopify.app.toml`, then `shopify app deploy --client-id <partner-app>`.
4. Export brand masters to PNG; capture screenshots; record the demo video.
5. Paste `docs/appstore/listing.md` values into the Partner Dashboard listing.
6. Point the listing's legal URLs at `https://<app-host>/legal/*`.
7. Submit for review.
