# M1 — Shopify App Core (Shopify App Core milestone doc)

> Status: COMPLETE (verified: 107 tests · 89% coverage · strict typecheck · build)
> Spec traceability: P1/P2 (Shopify integration, auth, permissions), P5 (security lists), P7 (GDPR), P12 (multi-tenant security, webhook reliability)

---

## 1. What a merchant's install actually does

```
GET /shopify/install?shop={shop}.myshopify.com
  → domain sanitized (strict *.myshopify.com regex; anything else → 400)
  → state nonce minted (128-bit) + PERSISTED with 10-min TTL (shopify_oauth_states)
  → 302 → https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state

GET /shopify/callback
  → 1. hmac query-param HMAC verified (canonical query, timing-safe)
  → 2. shop re-sanitized
  → 3. state burned ATOMICALLY (UPDATE ... WHERE used_at IS NULL → replay = 401)
  → 4. code → OFFLINE access token (POST /admin/oauth/access_token, timeout+retry)
  → 5. shop profile fetched (GraphQL shop query)
  → 6. provisionStore tx: upsert stores (ACTIVE, reinstall-safe)
       + store_settings row + OFFLINE token AES-256-GCM → shopify_sessions
       + STARTER trial subscription (real TRIALING row, per-plan trialDays)
  → 7. audit shopify.app.installed · register APP_UNINSTALLED webhook
  → 302 → https://admin.shopify.com/store/{shop}/apps/{apiKey}
```

**Webhook registration policy (M1):** topics are declared in `webhooks/registry.ts`.
`APP_UNINSTALLED` is registered via API at install. GDPR topics (customers/data_request,
customers/redact, shop/redact) ride the platform's **mandatory webhook** declaration
(Partner Dashboard / app config); their handlers are live from day one and the shared
endpoint validates them identically. Business topics (orders/products/…) activate
with the M2 sync engine — registration is driven by the same registry, so M2 only
adds handlers. Registration failure audits `shopify.webhook.registration_failed`
FAILURE and never fails the install (covered by test; M2 reconciliation job re-registers).

## 2. Embedded session authentication

```
App Bridge session token (Authorization: Bearer)
  → POST /api/v1/auth/session
  → verify: HS256 signature + audience=apiKey + issuer pinned to iss shop
            + iss/dest agree + expiry
  → store must exist & be ACTIVE
  → online token (token-exchange grant) — reused while fresh (>5 min TTL left)
  → JIT provision user by shopify sub; first member of a store (or Shopify
    account_owner) ⇒ OWNER, everyone else ⇒ VIEWER until promoted
  → app session row + refresh token (only SHA-256 hash stored)
  → issue: 15-min access JWT (claims: userId/sessionId/storeId/role/permissions)
           + 30-day rotating refresh token
GET  /api/v1/auth/me      → fresh profile/permissions (role changes picked up)
POST /api/v1/auth/refresh → rotation; REPLAYED refresh ⇒ entire session chain
                            revoked + gdpr-grade audit trail (reuse detection)
```

Every other endpoint speaks **first-party JWTs only** and every request passes
`requireAppAuth → requireActiveStore (fresh DB check; suspend = instant 403)
→ requirePermission(...)`. Permissions come from the seeded role→permission
matrix (`seedPlatformCatalogs`, 24 permissions, 7 roles).

## 3. Tenant isolation — three enforced layers (I2)

1. **ALS context:** tenant middleware pins `storeId`; logging/envelope carry it.
2. **Repository discipline:** tenant reads run through `withStoreScope(db, storeId, tx)`.
3. **Postgres RLS (migration 0002):** inside that transaction the connection
   assumes the restricted `profit_app` role + `app.store_id`; policies on all
   tenant tables (+ EXISTS policies for refresh_tokens/job_retries via parents)
   make cross-tenant reads/writes physically impossible for that role.
   Platform ops (install/uninstall/GDPR/migrations) run on the owner role —
   few, audited, and confined to the shopify module.
   **Proven by tests:** cross-tenant SELECT returns only own rows; cross-tenant
   INSERT raises a row-level-security violation at the engine; cross-tenant
   UPDATE is a no-op.

## 4. Webhook pipeline (P2 pipeline implemented verbatim)

validate HMAC (raw body, `x-shopify-hmac-sha256`) → verify store → persist
webhook_logs (unique `(store,topic,delivery)` ⇒ **dedupe is a constraint, not
a promise**) → dispatch registry handler → status transitions
RECEIVED→PROCESSED/FAILED (+ audit). Handler failures are recorded and still
acknowledged (200) so poison payloads can't create Shopify retry storms;
replay/re-drive tooling over FAILED rows arrives with the M2 job infrastructure.

Handlers shipped: `app/uninstalled` (status flip, token deletion, session chain
revocation), `customers/data_request` (audited for platform export),
`customers/redact` (physical payload scrub across webhook_logs by customer id),
`shop/redact` (full payload purge + store contact PII wipe + session IP scrub).

## 5. Security checklist mapping

| P5/P12 requirement | Implementation |
|---|---|
| OAuth state validation | persisted single-use state, atomic burn, 10-min TTL (tested replay → 401) |
| HMAC verification | both flavors (webhook raw-body, callback canonical query), timing-safe |
| Webhook signature validation | per-topic header verification before ANY processing (tested nothing stored on fail) |
| Session token validation | jose HS256, audience+issuer pinning, iss/dest agreement |
| App uninstall cleanup | status + token deletion + session revocation (tested) |
| Store ownership validation | requireActiveStore + RLS (tested incl. suspended → 403) |
| Token storage | AES-256-GCM, rotation window, never returned to clients (tested tamper/wrong-key) |
| Never log secrets | pino redaction (unit-tested) |
| Replay attack prevention | state burn + delivery dedupe + refresh rotation reuse-kill |

## 6. Operations runbook (per environment)

```bash
# platform variables (Railway): see .env.example — JWT_SECRET, ENCRYPTION_KEY (base64 32B),
#   SHOPIFY_API_KEY/SECRET/SCOPES/APP_URL, DATABASE_URL, REDIS_URL are MANDATORY in prod
pnpm install --frozen-lockfile
pnpm --filter @profit/db run migrate     # applies 0000, 0001, 0002 (incl. RLS role+policies)
pnpm --filter @profit/db run seed        # idempotent roles/permissions/plans
pnpm --filter @profit/api run build && pnpm --filter @profit/api start
# probes: /live /ready /health — /ready reports REAL db status
```

## 7. Verification results (this milestone)

- 16 test files, **107 tests** — 0 failures
  - integration: OAuth install→callback→provision (real PG via PGlite), webhook
    intake incl. dedupe/unknown-store/GDPR×3/registration-failure, auth session→
    me→refresh-rotation→reuse-revocation, RLS cross-tenant reads/writes, HTTP
    tenant boundary, RBAC guards
  - unit: AES-GCM (7), HMAC (9), session token (7), JWT (5), http-client
    resilience (6), shop-domain (11), env (8), envelope/errors/logger/context/health
- Coverage: **89% lines / 76.5% branches / 92% functions** (gates: 80/75/80/80)
- Strict typecheck: clean across `types`, `db`, `api`
- Build: tsup ESM bundle green
- M1 acceptance rule: no mocks of persistence anywhere — only outbound Shopify
  HTTP is stubbed at the tests' network boundary.

## 8. Known follow-ups (owned by later milestones, not debt)

- Registry-driven registration of business topics → M2 (sync engine consumes).
- FAILED webhook replay tooling → M2 queue infrastructure (failed_jobs DLQ).
- Trial → paid Shopify Billing charge creation → M5 (trial row already real).
- Webhook reconciliation job (re-register on self-heal cadence) → M2 scheduler.
