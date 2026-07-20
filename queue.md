# RAI Dev Queue
_Unattended development loop for the rai product repo. Drop dev jobs in Pending, then fire and leave._
_Repo-scoped twin of no5-context/queue.md. Closes jobs by committing green code, not by writing OLs._

## How to use
1. Add jobs under **Pending** (one `- [ ]` per job, self-contained: what + which package/files + acceptance/how-to-verify + any constraint), OR let a session drop a candidate into **Suggested**, auto-promoted next drain if unambiguously safe.
2. Drain it: fire **`/loop /drain-queue-rai`** from `/Users/ich/rai`, or let the nightly headless runner do it (see cron below). Each pass does ONE job: verify green baseline → build → test → commit to the rai repo → next.
3. On return: read **Done** (commit refs) + **Blocked** (jobs that hit a gate or couldn't close green) + **Suggested** (candidates needing your glance).

_Cron: `scripts/drain-queue-cron.sh` (headless nightly, cwd=~/rai). Skips silently if Pending is empty. Not yet loaded into launchd: see the plist in scripts/ and the one-liner Tim runs to enable it._

## Contract (what firing the queue authorizes)
- Firing `/drain-queue-rai` over a job IS the Phase B `go` for that job's commit. Each job self-commits to the rai repo.
- **Green is the close gate.** `npm run build` + `npm test` for every touched package must pass. A red tree → restore-to-green + move to Blocked. Never commit red.
- **Serialized, never parallel.** One job fully committed before the next starts.
- **Hard stop, never guessed** (moved to Blocked): CWS/store publish, VPS/host deploy, npm publish, external send/post/DM, `.env`/secrets/`_vendored/` scp, delete/overwrite non-run files, git-history rewrite, money/paid-API spend, breaking a locked vocab/schema without a stated compat path, or any genuine decision fork with no safe default.
- **DESIGN-PROPOSAL / architecture forks never auto-promote** from Suggested (P2 consensus design, threat-schema changes, brand/deck copy, breaking API changes). They wait for Tim.
- Scope = rai repo only. No5-context OL/decision-log closure happens there, not here; if a job needs it, do the code half and Block the OL half.
- A job needing a higher model tier flags it and continues.

## Pending
<!-- Add jobs below. Top = next. Self-contained + state how to verify green. -->


## Suggested
<!-- Candidate dev loops. `/drain-queue` sweeps this first: gate-clean non-design items auto-promote.
Design/architecture forks stay for Tim's glance. Each: what + which package/OL + one-line why-now. -->

- [ ] **[DESIGN-PROPOSAL] P2 agent implementation** (packages/p2-agent, agents stubbed per CLAUDE.md). Multi-agent consensus reasoning is judgment-heavy and the consensus contract is a locked schema: architecture decision, needs Tim. Do NOT auto-promote. When Tim scopes it, split into per-agent build jobs.

## Blocked
<!-- Jobs the drain hit a gate on. Each: what it needs from Tim. -->

## Done
<!-- Auto-appended by /drain-queue: - [x] JOB, <commit> <date> -->

- [x] Add a fast `typecheck` script to each package + root, fixed p2-agent's pre-existing red first (bs-council-runner.test.ts type-narrowing) so root typecheck lands clean across all 7 packages. `3b47cfa` 2026-07-20
- [x] Wire `rayScan()` to call `blockReasonFromScanSignals` and attach `block_reason` to blocked verdicts (per Tim's explicit go); commit block-reason v1 module fully green, 22/22 block-reason tests, 281/281 core suite, build+typecheck+test clean across all 7 packages. `44da6d7` 2026-07-20
- [x] RAI extension smoke-test harness (packages/extension, OL-241): vitest smoke that loads the real `npm run build` output (manifest.json + service-worker chunk) with a mocked chrome API, asserts P0 blocks a known injection string end-to-end, and asserts every manifest-declared file exists in dist/. Playwright/real-browser path skipped: not installed, would need a network download (job's own guard). `44eed44` 2026-07-20