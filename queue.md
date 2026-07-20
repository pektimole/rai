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

- [ ] **Add a fast `typecheck` script to each package + root** (dev-loop infra, self-improving). In every `packages/*/package.json`, add `"typecheck": "tsc --noEmit"` to `scripts` (skip any package that has no `tsconfig.json`, note which). In root `package.json`, add `"typecheck": "npm run typecheck --workspaces --if-present"`. Purpose: give the drain's green-gate a fast check that doesn't emit build artifacts. VERIFY: `npm run typecheck` runs clean at root (core already passes `tsc --noEmit`; if another package is red, that's a pre-existing red, Block with the failing package, do NOT "fix" unrelated type errors in this job). Internal, no gates, safe to commit.

## Suggested
<!-- Candidate dev loops. `/drain-queue` sweeps this first: gate-clean non-design items auto-promote.
Design/architecture forks stay for Tim's glance. Each: what + which package/OL + one-line why-now. -->

- [ ] **Commit the block-reason v1 module as a tested unit** (packages/core, OL-300 33- Part B). `block-reason.ts` + `block-reason.test.ts` currently sit untracked in packages/core. Job: run `npm test -w packages/core`; if the block-reason suite is green, `git add` exactly those two files and commit `feat(core): block-reason v1 header set (OL-300)`. GUARD: this stages in-flight WIP Tim authored: only auto-close if the suite is fully green and the diff is exactly those two files; otherwise Block. Why-now: WIP is tested and idle, closing it locks the v1 vocabulary.

- [ ] **[DESIGN-PROPOSAL] P2 agent implementation** (packages/p2-agent, agents stubbed per CLAUDE.md). Multi-agent consensus reasoning is judgment-heavy and the consensus contract is a locked schema: architecture decision, needs Tim. Do NOT auto-promote. When Tim scopes it, split into per-agent build jobs.

- [ ] **RAI extension smoke-test harness** (packages/extension, OL-241). Add a headless vitest/Playwright smoke that loads the built MV3 bundle and asserts the P0 scanner fires on a known injection string. Why-now: OL-241 lists "smoke test browser_extension" as the open pending item. GUARD: pure test-add, but if it needs a real browser download/install, Block for Tim to authorize (download-execute gate).

## Blocked
<!-- Jobs the drain hit a gate on. Each: what it needs from Tim. -->

## Done
<!-- Auto-appended by /drain-queue: - [x] JOB, <commit> <date> -->