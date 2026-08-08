# SOC-2-lite Evidence Pack (M7)

Not a certification — an evidence system built on ledgers the codebase
actually keeps. Every control below maps to a shipped mechanism with an
executable test; nothing is asserted on paper only.

## Control inventory (evidence source → mechanism → test)

| Control | Mechanism (code of record) | Evidence | Executable proof |
| --- | --- | --- | --- |
| CC6.1 Logical access | RBAC: `roles` × `rolePermissions` × `userStoreMemberships`, permission-checked on every route (`requirePermission`) | members + permission breadth per store | `tenant-rls.integration.test.ts`, auth suites |
| CC6.1 Tenant isolation | Postgres RLS + `withStoreScope` transaction pinning; claim-derived tenancy only (headers/query are never trust sources) | physical cross-tenant invisibility | `tenant-rls.integration.test.ts`, `security.suite.test.ts` |
| CC7.2 Operator access logging | `platform_admin_actions` ledger (every admin read + write, with operator, reasoning, IP) | operator action log | M5–M7 admin integration tests |
| CC6.2 Privileged write gating | 15-minute step-up sessions (`/admin/session`), memory-only key, expanded-reason payloads hashed into the ledger | `access-review/sessions` read model | M6/M7 admin tests |
| CC6.3 Access overrides time-boxed | `access_overrides` with `accessUntil`, `revokedAt`| rows surfaced by access review | `access-review.integration.test.ts` |
| CC7.1 Activity monitoring | Append-only `audit_logs` (no update/delete path in code) with actor, IP, request binding | merchant audit UI + CSV/PDF export | audit suites |
| CC7.3 Incident response hooks | `failed_jobs` DLQ, `job_retries`, health probes `/live` `/ready` `/health` | ops surfaces | `load.suite.test.ts` (zero-DLQ assertion), health tests |
| CC8.1 Change management | ADRs + PR gates (typecheck/test/coverage/build/migration drift) + ONE-commit-per-milestone discipline | `docs/architecture/ARCHITECTURE.md`, CHANGELOG | repo gates |
| C1.1 Confidentiality | Offline tokens encrypted at rest (`ENCRYPTION_KEY` envelope), no secret in logs (pino redaction), error messages never leak 5xx internals | encrypted rows, redacted logs | M1 OAuth tests, error-handler tests |

## Access review procedure (quarterly, and on any suspected incident)

The M7 access review is a **read model over the existing IAM/audit ledgers —
no new tables** (ADR 27). Procedure:

1. Open the admin console → **Access review** (key-gated, step-up protected
   for any write).
2. Pick the store. Verify every member row: email ↔ expected human,
   `roleCode` ↔ least privilege, `permissionCount` ↔ role breadth,
   `lastLoginAt` ↔ active humans only.
3. Review **live overrides**: any `accessUntil` in the past without
   revocation is an exception — revoke through the admin write surface
   (itself ledgered) and record the reason.
4. Review **recent operator writes** for the store and the
   **write-authority grants** (all step-up sessions with operator identity +
   origin IP): every row must map to a known operator action.
5. Export evidence: merchant-side audit CSV/PDF (audit page) for the same
   window; attach both to the review ticket.
6. Record completion in the change log (see
   `docs/ops/change-management.md`) with operator identity and findings.

The same read model is available as JSON:
`GET /api/v1/admin/access-review?storeId=…` and
`GET /api/v1/admin/access-review/sessions` (platform-admin key required).

## GDPR/CCPA posture evidence

- GDPR mandatory webhooks (`customers/data_request`, `customers/redact`,
  `shop/redact`) have live handlers from day one (inline delivery — compliance
  never waits on a queue); proven in webhook suites.
- Data export: merchant self-serve exports (orders/customers/audit) on the
  exports surface; store deletion via uninstall cleanup (`handleAppUninstalled`).
- CCPA: not required at launch — embedded app sets **no first-party marketing
  cookies**, sells no personal information. Revisit with the marketing site.
  Cookie-consent likewise: no non-essential cookies on the embedded surface,
  so no consent banner; both re-assessed at marketing-site launch.
- Legal documents: `/legal/*` (privacy/terms/refunds/acceptable-use/security),
  versioned, effective-dated, support mailbox from `SUPPORT_EMAIL`.

## Incident & change controls

- Incident handling: `docs/ops/incident-runbook.md`.
- Release gates and rollback: `docs/ops/release-runbook.md`.
- Change-management rules (ADRs, review, versioning): `docs/ops/change-management.md`.
