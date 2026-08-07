# M6 — Automation Center + Campaigns

Status: **complete/PRE-SHIP** (gated by M7). Scope from ROADMAP: workflow DAG engine + builder UI · Email/SMS campaign centers (templates, A/B, tracking pixel/links) · cron scheduler · exports (CSV/XLSX/PDF) · audit-log UI export · support tickets · platform-admin **write** actions with operator identity + step-up auth. Plus the two infrastructure gaps the milestone exposed: a tracking threat model hardened *before* a single public endpoint shipped, and a backfilled test surface for every new write path.

M6 turns the platform from a recommendation engine into an action engine: playbooks run unattended against live webhook traffic, campaigns deliver real email/SMS with closed-loop attribution signals, and support/ops workflows (tickets, trial extensions, access overrides) stop being SQL console work.

## 1. What merchants get

- **Automation hub (`/automation`)** — a workflows-first surface with the M4 guardrails panel preserved as a tab:
  - **Workflow builder** — layered DAG canvas (deterministic longest-path layout, real SVG edges with branch-tinted YES/NO strokes), node palette (condition / wait / send email / send SMS / tag customer / create discount), per-node config forms whose bounds mirror the server zod schemas, connect-mode with **automatic branch discipline** (a condition owns exactly one YES then one NO edge; every other node owns one plain edge; the trigger accepts no incoming edges), and a remediation-style issue list (cycle / unreachable / missing-branch / dangling-edge / trigger-incoming) that gates **Activate** — the client lint is a UX mirror only; the server validator re-checks everything on save/activate (I: never trust the client).
  - **Versioning** — every definition save mints an **immutable version**; activating binds a version, so a live playbook never mutates mid-run. `Run once` is available only when ACTIVE; **Pause** freezes scheduled/event fan-out without losing state; **Archive** is confirmed, permanent, and keeps versions + the run ledger readable (read-only summaries of the frozen config).
  - **Run ledger** — per-run rows (status, trigger kind, timing, error) expanding into per-node **steps** with attempts and detail — the observability contract for unattended automation.
  - **Trigger kinds** — MANUAL (operator runs it), SCHEDULE (5-field UTC cron, materialized as repeatable BullMQ jobs by the worker tick), EVENT (Shopify webhook topics; runs fire once per real delivery, deduped by event id).
  - **Execution semantics** — CONDITION branches evaluate against the tenant replica (orders count, lifetime spend, marketing opt-in, tags, event total/currency); DELAY parks the run in `workflow_runs.resume_at` and the tick resumes it; SEND_* renders the **closed template catalog** (11 variables — store/customer/campaign/workflow/unsubscribe, **no raw event interpolation**); TAG_CUSTOMER and CREATE_DISCOUNT execute against the Shopify API. Every step is idempotent by `(run, node)` records.
- **Campaigns (`/campaigns`)** — Email + SMS centers in one surface:
  - **Templates** — CRUD with the same closed variable catalog (duplicate name → honest 409), body text + optional HTML for email (multipart with plain fallback).
  - **A/B** — variant B subject/body; deterministic recipient split; the dashboard reports sent/opened/clicked per variant so the merchant picks the winner — the platform posts the decision (`winner`), it never silently auto-picks mid-flight.
  - **Compliance built-in** — the unsubscribe link is **appended by the sender, not editable copy**; unsubscribes/complaints/bounces land in a durable `message_suppressions` ledger that every future send filters against (CAN-SPAM by construction).
  - **Tracking** — a 1×1 pixel (42-byte GIF) and signed redirect links record OPENED/CLICKED events; scheduled sends pass per-variant rows at `scheduled_for`, cancellable while pending.
- **Exports (`/exports`)** — request CSV/XLSX/PDF for customers, orders, products, recommendations and audit logs, capped by `EXPORT_MAX_ROWS` (50k) with the cap stated in the UI; files render **zero-dependency** (own CSV/XLSX writers + a minimal PDF generator — no new supply chain), store in `export_files`, and download over an authorized route. **Audit Logs page** gained a one-click export wired to the same pipeline.
- **Support (`/support`)** — FAQ stays ungated; `support:read` unlocks the ticket workspace: create (category/priority/subject/body), list with status transitions, threaded replies, close. Operators see the same thread cross-tenant in admin.
## 2. Architecture

### New package: `packages/automation`

The M6 business plane, shared by `apps/api` (read/write surfaces, tracking router) and `apps/worker` (ticks, executor, campaign sender) — same precedent as `packages/sync`/`packages/billing`:

| Module | Responsibility |
|---|---|
| `definition.ts` | Zod schemas for the workflow DAG (nodes, edges, per-kind config bounds) — the **authoritative** contract the UI mirrors. |
| `dag.ts` | Server-side validator: exactly one trigger, no incoming trigger edges, condition ⇒ exactly YES+NO, acyclicity, reachability from the trigger. Runs on every save/activate regardless of what the client claims. |
| `workflow.service.ts` | CRUD + immutable version minting + lifecycle state machine (DRAFT→ACTIVE→PAUSED; ACTIVE→ARCHIVED terminal; activate requires a lint-clean definition). |
| `workflow.executor.ts` | The runtime: advances `workflow_runs` node-by-node with per-step idempotent records, condition evaluation against the replica, delay parking via `resume_at`, and terminal status transitions. |
| `cron.ts` | Pure cron parsing/matching for 5-field UTC expressions (no library). |
| `campaign.service.ts` / `campaign.sender.ts` | Campaign CRUD/schedule/cancel/winner + recipient materialization with suppression-ledger filtering and variant split. |
| `template.ts` | The **closed** 11-variable interpolation catalog (single source — the web cheat-sheet renders the same list). |
| `tracking.ts` / `tracking.service.ts` | Stateless **HMAC-signed tracking tokens** (verify on hit — no per-click DB reads), pixel GIF constant, event recording + unsubscribe landing + suppression writes. |
| `twilio-sender.ts` | Twilio SMS adapter behind the `SmsSender` port; when `SMS_TWILIO_*` is unset the worker runs with a **fail-fast** sender (see §3). |
| `export/` + `export.service.ts` | Zero-dep CSV/XLSX/PDF writers; queries capped by `EXPORT_MAX_ROWS` (50k) and rendered into `export_files` rows. |
| `support.service.ts` | Ticket + message ledger (merchant side); operator reads flow through the admin plane. |
| `jobs.ts` | The BullMQ job envelope vocabulary (typed job names/payloads). |

### Worker wiring (`apps/worker`)

One **automation tick** (`AUTOMATION_TICK_INTERVAL_MS`, default 60s, floored at 5s) drives three sweeps:

1. **Cron fan-out** — SCHEDULE-triggered ACTIVE workflows whose expression matches the minute get enqueued (`workflow.run`), Electron-style window = the tick itself; `next_fire_at` is a projection for the list UI.
2. **Run resume** — RUNNING runs with `resume_at <= now` continue from `resume_from_node_id`.
3. **Campaign batches** — SENDING campaigns enqueue `campaigns.send-batch` chains: ≤ `CAMPAIGN_SEND_BATCH_SIZE` (50) recipients per job, next batch re-enqueued with `CAMPAIGN_SEND_THROTTLE_MS` (2s) delay. The chain is **deduped by BullMQ jobId** (`campaign-send:{id}:cursor:*`), so a tick that observes a stale SENDING row while a chain is alive cannot fork a second chain (the add is a no-op).

EVENT-triggered runs are enqueued directly by the webhook applier path (event id = idempotency key), and `workflow.run-once` covers the manual path. All three are the same executor entry point.

### API wiring (`apps/api/src/modules/automation-center`)

- Tenant routers: `workflows`, `campaigns|templates|suppressions`, `exports`, `support` — all permission-gated with seeded roles (OWNER/ADMIN full; STAFF/ANALYST read/manage per matrix).
- **Tracking router** (`tracking.router.ts`) — mounted **unauthenticated by design**: the signed token *is* the authorization (stateless HMAC, see §5). `GET /t/o/{token}` records OPENED and serves the GIF with long-cache headers; `GET /t/c/{token}` records CLICKED and 302s to the embedded destination; `GET /t/u/{token}` records the unsubscribe and lands on an "You're unsubscribed" HTML page that never reveals whether the address exists.

### Admin plane v2 (`apps/api/src/modules/admin` + `apps/web/src/admin`)

M5 shipped the key-gated **read-only** console. M6 adds the write half:

- **Step-up sessions** — `POST /api/v1/admin/session {operatorId, reason}` mints a short-lived (15 min) opaque session. The key authorizes **reads**; the session additionally authorizes **writes** (`X-Platform-Admin-Key` + `X-Admin-Session` on every mutating call). The web console persists only the *session* in `sessionStorage` (drops stale/expired sessions on boot); the **key itself is still never stored** — lock the console and it is gone.
- **Write surface** — ticket reply / status transition, **extend trial** (TRIALING stacks days, EXPIRED reactivates the remaining window; mints a `TRIAL_EXTENDED` billing event), **grant/revoke access override** (time-boxed billing-gate bypass: `COMP_ACCESS`, `PAUSED_EXTENSION`, `CHARGE_FAILURE_GRACE`, always expiring, undoable where undo exists).
- **Operator action log** — every write records `platform_admin_actions{operatorId, action, target, payloadHash, ip}` — the SOC-2-lite evidence trail M7 needs. The console's Action Log is deliberately **session-honest**: it lists the server's most recent page with a real prev/next cursor, never a fake "page N of many".

### Merchant web (`apps/web`)

16-section shell (roadmap placeholders are all gone; `SectionRoadmapPage` stays as permanent M7+ infrastructure): the M4 automation page becomes the hub with the **AI guardrails panel moved unchanged** into a tab; campaigns/exports are full pages; the builder surface is `pages/automation/*` with the **pure** `workflow-builder.ts` (graph ops + lint + layered layout — unit-tested without a DOM) kept separate from the four thin view components.

## 3. Key decisions (amendments — logged per the rules)

1. **`packages/automation` as a shared plane, not an app** — api routes and worker handlers are both thin adapters over the same services; the executor never imports Express/BullMQ (ports only). This kept the entire DAG/interpolation/cron core unit-testable without a container.
2. **Client lint is a mirror, never an authority** — the UI's issue list exists to *explain*; the server validator in `dag.ts` re-runs on save + activate. A hand-crafted API payload cannot activate an invalid graph.
3. **Template catalog is CLOSED (11 variables, no `event.*`)** — open interpolation would leak raw webhook payloads (addresses, line-item PII) into outbound messages. New variables require an explicit allowlist edit + test, same as the M4 context-builder minimization list.
4. **Tracking tokens are stateless HMAC, not DB rows** — pixel/link hits are high-volume, cache-hostile, and media-proxy-amplified; verification must not touch Postgres. Signed claims carry exactly `campaignId/variant/recipientHash/channel` (+destination URL for clicks bound into the signature) — no store id, no email address, nothing enumerable.
5. **SMS fail-fast when Twilio is unconfigured** — a campaign containing SMS with no `SMS_TWILIO_*` env fails loudly at send time (step FAILED with a merchant-readable reason) rather than silently skipping the channel; silent-skip turned a misdeployment into invisible lost campaigns in staging.
6. **Export writers are zero-dependency** — CSV/XLSX/PDF generators hand-rolled (~300 LOC total) instead of adding `xlsx`/`pdfkit` supply chain for a low-throughput internal tool; XLSX targets the minimal OOXML subset Excel/Numbers/Sheets all open, PDF targets single-page-table subset — both contract-tested by parsing headers back.
7. **Export files in `bytea`, capped** — hard cap `EXPORT_MAX_ROWS` (50k) keeps files to low-MB; a DB row keeps tenant isolation, audit, and lifecycle identical to the record itself with zero new infra (object storage stays on the M7+ shelf for uncapped exports — documented trade-off).
8. **Admin writes need a session because reads must not** — support reads happen constantly; writes are rare and dangerous. Re-entering nothing (key already in hand) would make every read session write-capable; a distinct 15-minute step-up carries the write authority and its own audit identity, and expiring sessions self-revoke without operator hygiene.
9. **The admin session lives in `sessionStorage`, the key lives nowhere** — closing the tab drops write authority; the raw key is still typed per session (M5 rule held). A stale stored session is dropped on boot, verified by test.

## 4. Failure modes handled

- **Duplicate template names** → unique constraint + honest `409 TEMPLATE_NAME_TAKEN` (regression-tested).
- **Double-send race on campaign ticks** — a tick observing SENDING while a batch chain lives no-ops via BullMQ jobId dedupe; the cursor chain resumes where it stopped (chain recovery after a hard worker kill mid-chain is the one item deferred below).
- **Pixel/link replay & forgery** — signature binds channel+recipient+campaign(+URL); replays record duplicates countably (idempotency debated and accepted: counting proxies is *product* truth, links themselves never mutate tenant state); unsubscribe is idempotent by ledger upsert.
- **Suppression ledger is checked per batch, not per campaign start** — an unsubscribe mid-send stops remaining batches immediately.
- **Workflow edits under a live run** — runs bind the **version** active at start; saving a new version never migrates in-flight runs.
- **Delay overflow** — wait caps at 30 days in both the zod schema and the form bounds.
- **Step crash mid-node** — per-step rows make retries idempotent; a crashed SEND never duplicates a message for the same `(run, node)`.
- **Stale admin session** — expired tokens are rejected server-side and the console drops them on boot instead of failing every write with a mystery 401.
- **Trial extension audit** — every extension emits a `TRIAL_EXTENDED` billing event (enum + migration 0007), so billing reconciliation stays explainable.

## 5. Tracking threat model (written before the endpoints shipped)

Assets: recipient email/phone, campaign contents, store reputation, operator trust.

| Threat | Decision |
|---|---|
| Token enumeration → read campaign metrics of strangers | Tokens are 128-bit random + HMAC-signed; claims contain **no email, no store id** — a captured token reveals only aggregates of its own campaign row. |
| Click-link open redirect abuse | Destination URL is **inside the signed claims**; tampering invalidates. No `?to=` query input is ever trusted. |
| Unsubscribe endpoint as an email-existence oracle | Landing page is static copy identical for valid/invalid/expired tokens; suppression write is best-effort idempotent. |
| Mail-scanner pixel prefetch inflating opens | Accepted and **documented** (industry-wide); opens are a directional signal, never a billing/attribution input. Attributed-revenue math uses real order data only. |
| Signed-token secret rotation | `TRACKING_LINK_SIGNING_SECRET`/`TRACKING_SIGNING_SECRET` on both api+worker; in-flight old links die on rotation — acceptable blast radius, runbook notes scheduled-turnover windows. |
| Public route used as DDoS amplifier on Postgres | Verification is pure crypto; event writes are single-row upserts behind the existing global rate limiter; no JOIN, no session lookup on the hot path. |

## 6. Verification (this milestone's evidence)

- `packages/automation` — **160 tests**: DAG validator, executor (incl. idempotent-step retries), cron parser, closed template catalog, campaign materialization + suppression filtering + variant split, tracking sign/verify wall-clock expiry, export writers (round-trip parsed), support ledger, Twilio adapter fail-fast.
- `apps/api` — **220 tests** total; automation-center integration suite = 21 (workflows/campaigns/exports/support/tracking over PGlite + RLS, duplicate-template 409 regression); admin M6 integration (session mint/expiry, write-header enforcement, extend-trial + override + ticket writes with `platform_admin_actions` rows).
- `apps/worker` — **48 tests** incl. automation tick fan-out, delay resume, cron materialization, campaign batch chain + jobId dedupe, SMS fail-fast.
- `apps/web` — **195 tests / 30 files** (M6 +45): builder pure-module, canvas interactions (connect/branch-discipline/illegal-link toast/disconnect from canvas *and* panel), node-config forms per kind (bounds + uppercase/rounding/flooring), metadata-vs-immutable-version saves, archived read-only summaries, lifecycle POSTs, campaigns/exports/support workspaces, admin session step-up (mint, persist session-only, stale-drop, both-write-headers on every mutation, grant/revoke/extend flows).
- Workspace: **974 passed + 4 skipped** (Redis-gated cache/queue suites skip by design), `pnpm -r run typecheck` = 0 errors, `pnpm -r run build` green (api 544 KB ESM, worker 1.97 MB ESM, web vite), per-package coverage gates green (web 93.44/81.49/80.96/93.44), `pnpm --filter @profit/db run generate` = **no drift** (0007 snapshot repaired to match its own SQL).
- Hand-verified: workflow create→build→lint-gate→activate→run-once→ledger; campaign A/B schedule→batch sends→open/click/unsubscribe pixel+link hits→suppression honored next batch; CSV/XLSX/PDF export of orders + audit logs; admin unlock→reply→resolve→extend-trial→grant/revoke with action-log rows.

## 7. Deferred (honest list)

1. **Stalled campaign-chain recovery** — if a worker dies *mid-chain* (batch enqueued, successor not yet added), the campaign stays SENDING until operator action. The dedupe jobId prevents duplicates, so recovery is a manual "resume" call or a future watchdog sweep; documented rather than half-built, because a naive auto-resume risks the exact double-send §4 prevents.
2. **Uncapped export storage** — `bytea` cap is 50k rows; object-storage spill (S3 port already exists in decisions #12) lands with the first tenant breaching the cap.
3. **Live preview in the sandbox** — dev servers + PGlite boot fine for tests, but the session-bound sandbox has no real Shopify storefront, so e2e hand-verification ran against integration servers; not a code gap.
4. **Profit card on the dashboard** — still blocked on the COGS source decision (carried from M5 risks; M7 item).
5. **Conversion-brand surface for campaigns** — link tracking measures clicks, not downstream revenue (order-webhook joins are M7+ attribution v2).
