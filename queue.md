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

- [ ] **RAI extension smoke-test harness** (packages/extension, OL-241). Add a headless vitest/Playwright smoke that loads the built MV3 bundle and asserts the P0 scanner fires on a known injection string. Why-now: OL-241 lists "smoke test browser_extension" as the open pending item. GUARD: pure test-add, but if it needs a real browser download/install, Block for Tim to authorize (download-execute gate).

## Blocked
<!-- Jobs the drain hit a gate on. Each: what it needs from Tim. -->

- [ ] **Commit the block-reason v1 module as a tested unit**, not fully green: `npm test -w packages/core, block-reason` is 21/22 passing. The one failure is `rayScan block_reason integration > populates block_reason on a blocked verdict` (`block-reason.test.ts:241`, `expected undefined to be defined`), `rai-scan-p0.ts`'s `rayScan()` is not yet wired to call `blockReasonFromScanSignals` and attach `block_reason` to blocked verdicts. Per the job's own GUARD (only auto-close if fully green), left `block-reason.ts` + `block-reason.test.ts` untracked/uncommitted, did not wire the integration myself (real feature addition, out of scope for this job). Needs Tim: either finish wiring `rayScan` to `block_reason`, or say the WIP should land with that integration test skipped/pending.

## Done
<!-- Auto-appended by /drain-queue: - [x] JOB, <commit> <date> -->

- [x] Add a fast `typecheck` script to each package + root, fixed p2-agent's pre-existing red first (bs-council-runner.test.ts type-narrowing) so root typecheck lands clean across all 7 packages. `3b47cfa` 2026-07-20