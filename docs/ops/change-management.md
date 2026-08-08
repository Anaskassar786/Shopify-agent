# Change Management

Small, real, and enforced by gates — the process that got M0→M7 here.

## Rules

1. **Architecture before code (Rule 6).** Any structural decision is written
   down as an ADR entry in `docs/architecture/ARCHITECTURE.md` BEFORE its
   implementation lands. Numbered, single-sentence decisions with context and
   consequence — 32 entries as of M7.
2. **Everything through PR.** Protected `main`; session work happens on the
   session branch and is squash-merged after gates pass. Milestones produce
   exactly one commit (see CHANGELOG history: M0–M6).
3. **Gates are the review.** Typecheck (strict, `exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`), tests, coverage thresholds (80/75/80/80),
   build, migration drift. A red gate blocks merge — no exceptions with a
   comment promising to fix later.
4. **No secret material in version control.** Env config in `.env` files
   (gitignored), template in `.env.example`, secrets in the hosting platform
   (Railway variables). Key rotation is a platform operation, not a commit.
5. **Versioning.** Keep-a-Changelog `CHANGELOG.md`; root `package.json`
   `version` is the product version (1.0.0 at M7); `APP_VERSION` env surfaces
   it in `/live`. Bumps happen at milestone commits only.
6. **Documentation is a gate.** ROADMAP, README status, ARCHITECTURE/ADRs and
   the milestone doc ship in the same commit as the feature.

## Hotfix path

Same gates, smaller scope: branch → fix + regression test (the failing case
first) → PR → merge. Never direct-to-main, even under SEV-1; the gates run in
minutes and exist precisely for that moment.

## Evidence cadence

- Quarterly access review → `docs/security/soc2-lite.md` procedure.
- Release → `docs/ops/release-runbook.md` checklist attached to the ticket.
- Incident → `docs/ops/incident-runbook.md`; RISKS updated in the fix PR.
