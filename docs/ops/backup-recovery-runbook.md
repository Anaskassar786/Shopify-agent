# Backup & Recovery Runbook

Data protection for PROFIT TOOL AI in production. Scope-capped to what the
system actually stores and what the hosting platform actually provides —
nothing here is aspirational.

## What needs protecting (and what does not)

| Data class | Where | Protection strategy |
|---|---|---|
| All business state (stores, catalog, orders, analytics, AI runs, workflows, campaigns, billing ledger, audit, exports, report PDFs) | PostgreSQL 16 (single primary) | Managed snapshots + PITR (**this runbook**) |
| Encrypted Shopify offline tokens, secrets at rest | PostgreSQL (encrypted columns) | Same DB protection + `ENCRYPTION_KEY` custody (below) |
| Queue in-flight jobs (BullMQ) | Redis | **Not backed up by design** — the durable `background_jobs`/`failed_jobs` mirror in Postgres is the recovery surface; transient queue loss converges by re-enqueue |
| Static assets / build artifacts | container image | Rebuilt from git — never backed up |

**Custody rule**: a Postgres restore without its `ENCRYPTION_KEY` (and
`ENCRYPTION_KEY_PREVIOUS` during rotation) yields unreadable token
columns. Store the keys in the hosting platform's secret store AND one
offline copy (password manager vault); they are never in git (enforced by
review + `.env.example` placeholders).

## Targets

| Metric | Target | Basis |
|---|---|---|
| RPO (snapshots) | ≤ 24 h | Daily managed snapshot |
| RPO (PITR window) | ≤ 5 min | WAL archiving / point-in-time recovery |
| RTO (service restore) | ≤ 60 min | Redeploy image + restore DB + smoke |
| Restore drill | before App Review submission, then quarterly | Procedure below |

## Setup (Railway reference; translate to the hosting platform)

1. **Managed Postgres**: enable the platform's backup plan (daily
   snapshots with retention ≥ 14 days) and point-in-time recovery (WAL).
   Record the retention on the service page; screenshot it into the
   release evidence folder.
2. **Snapshot retention policy**: daily × 14, weekly × 4 — enough to
   recover from a slow-discovered corruption without paying for forever.
3. **Key custody**: `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`,
   `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SHOPIFY_API_SECRET`,
   `TRACKING_SIGNING_SECRET`, `PLATFORM_ADMIN_KEY` — platform secrets UI +
   offline vault entry stamped with date + environment.
4. **Cross-check**: `GET /ready` on both services must report `ready`
   with `database: ok` before considering the setup done.

## Restore test procedure (the drill — run once pre-launch, then quarterly)

1. Provision a THROWAWAY Postgres instance from the latest snapshot (or a
   PITR timestamp).
2. Point a staging API + worker pair at it (copy env, swap `DATABASE_URL`
   only).
3. Verify, in order:
   - `/ready` → `ready`, `database: ok`;
   - a dev-store install is listed (`GET /api/v1/admin/merchants`);
   - an encrypted offline token round-trips: trigger any sync for that
     store and confirm `sync_jobs` progress (proves `ENCRYPTION_KEY`
     custody);
   - RLS intact: the app user sees zero `platform_*` rows it must not
     (the platform tables carry RLS-enabled-no-policy by ADR 37 — verify
     `platform_flags` reads still work through the service role used by
     the API).
4. Record: snapshot/PITR timestamp used, wall-clock duration, verifier
   name → release evidence. **This is the RTO measurement.**
5. Destroy the throwaway instance.

## Recovery runbook (real incident)

1. **Decide the restore point**: last good state before the incident
   (corruption time, bad deploy time). PITR preferred; snapshot otherwise.
2. Engage **maintenance mode** from the admin Ops tab BEFORE the data-plane
   could serve stale state (ADR 37) — webhooks keep acking into durable
   intake, nothing is dropped.
3. Restore Postgres to the chosen timestamp per the platform's procedure.
4. Redeploy the LAST KNOWN-GOOD image (per release-runbook rollback:
   previous build artifact + forward-fix migration only — migrations are
   additive; never `DROP` in production).
5. Re-point `DATABASE_URL` if the platform created a new instance; restart
   API + worker.
6. Post-restore convergence (all idempotent, all already shipped):
   - sync engine: schedule the affected stores' incremental syncs (worker
     `sync.scheduled-tick` runs on cadence; force with the store's Sync
     page trigger);
   - webhook gap: the durable intake retries unprocessed rows; anything
     beyond the window is closed by the sync sweep in step 6;
   - queues: BullMQ re-enqueues from the durable mirror on boot; DLQ stays
     visible in `GET /api/v1/admin/ops/jobs`.
7. Smoke per release-runbook §Deploy step 4–5, then **lift maintenance**.
8. Ledger the incident: `platform_admin_actions` rows for the maintenance
   pair + a written entry per incident-runbook §Evidence & review.

## Failure modes this runbook deliberately does NOT cover

- Redis data loss — converges by design (durable mirror + re-enqueue).
- Region loss of the hosting platform — a full region migration is a
  planned event (new instance, restore from off-platform snapshot export);
  record the export path if the platform offers one, otherwise accept and
  document the residual risk (RISKS entry at first breach).
