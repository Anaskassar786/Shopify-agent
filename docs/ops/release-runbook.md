# Release Runbook

One release = one milestone commit (or a hotfix commit) on the working branch,
then merge to `main` per change-management policy. Every gate below is
executable in the repo — nothing here is aspirational.

## Preflight (local, in order)

1. `corepack pnpm install`
2. `pnpm -r run typecheck` — zero errors.
3. `pnpm -r run test` — all suites green (Redis-gated suites skip without
   `REDIS_URL` — that is their design).
4. Coverage per package: `vitest run --coverage` inside `apps/web`,
   `apps/api`, and each touched package — thresholds 80/75/80/80 (configured
   per package; a red threshold blocks the release).
5. `pnpm -r run build`.
6. Migration drift: `pnpm --filter @profit/db run generate` must report
   **no schema changes**. If it doesn't, either the change is missing its
   migration (add it) or the drift is unintended (revert).
7. Hygiene: no `console.log` outside bootstrap/seed, no new `any`, no
   placeholder terms in shipped copy (`TODO|FIXME|HACK` scan on changed
   lines), `.env.example` covers every new env var.

## Environment configuration (staging/production)

Provision per `.env.example`. **Production-required** additions validated at
boot (fail-loud superRefine in `config/env.ts`): Shopify keys+scopes,
`JWT_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`, `PLATFORM_ADMIN_KEY`, `TRACKING_SIGNING_SECRET`, and the M7 legal
pair `SUPPORT_EMAIL` + `LEGAL_ENTITY_NAME`.

## Deploy

1. Apply migrations: `pnpm --filter @profit/db run migrate` (idempotent;
   run BEFORE app rollout).
2. Railway deploy contract (two services from the same repo, root build/start):

   - **Build command (both services):** `pnpm build`
   - **API service start:** `node apps/api/dist/index.js`
   - **Worker service start:** `pnpm run start:worker` (i.e. `node
     apps/worker/dist/index.js`)
   - **API health check:** `GET /live` → 200
   - The worker is a **separate Railway service** that shares the same repo
     and the same root build. Both services run the same `pnpm build`; the
     only difference is the start command. The API serves HTTP; the worker
     is a long-running BullMQ consumer with no HTTP listener beyond its own
     health server (internal).
   - `APP_VERSION` pinned to the tag for both services.

3. Deploy API + worker + web (single build artifact set per service; the
   artifact for the API service is `apps/api/dist`, the artifact for the
   worker service is `apps/worker/dist`).
4. Render the Shopify managed config for the target host and deploy it:
   `APP_URL=https://<prod-host> pnpm --filter @profit/api run manifest:render -- --out shopify.app.toml`
   then `shopify app deploy --client-id <partner-app>` (ADR 30; credentials
   live in the Partner Dashboard, never in the repo).
5. Smoke: `GET /live` → 200, `GET /ready` → `ready` (four checks in the
   payload: `database` + `cache_queue` live probes, `ai_provider` + `shopify`
   configuration truth; a `skipped` configuration check is expected when the
   capability is intentionally unconfigured and never gates),
   `GET /legal/privacy` → 200 HTML with the configured entity + support email,
   embedded boot in a dev store admin.
6. Ops plane smoke (1.1.1): `GET /api/v1/admin/ops/flags` →
   `{"maintenance": null}` (or the live state), `GET /api/v1/admin/ops/jobs`
   → all five status buckets present; confirm `SENTRY_DSN` is set if error
   capture is desired (absent = documented no-op).

## Rollback

- App: redeploy the previous build (prior commit artifact).
- Schema: migrations are additive; rollback means a forward-fix migration —
  never `DROP` in production without a reviewed change ticket.
- Shopify managed config: re-render from the previous commit and re-deploy
  (`shopify app deploy` is declarative; re-applying the old file is the
  revert).

## Post-release evidence

- Record the release in `CHANGELOG.md` (Keep a Changelog; version from the
  root `package.json` — 1.0.0 at M7).
- Attach gate outputs to the release ticket; file the quarter's access-review
  reminder per `docs/security/soc2-lite.md`.
