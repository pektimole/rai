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

## Blocked
<!-- Jobs the drain hit a gate on. Each: what it needs from Tim. -->



## Done
<!-- Auto-appended by /drain-queue: - [x] JOB, <commit> <date> -->

- [x] Re-bind NanoClaw to new ActionGate module (Step 4, rai/docs/28-rai-actiongate-spec.md): **won't-do, Tim's decision 2026-08-04.** NanoClaw's write-gate has run standalone in production since 2026-03-21 with zero breaches; ActionGate was lifted from it April 2026 and has since grown its own adapters (shell/mcp/NMH/router-audit) that NanoClaw never uses. Rebind would be cross-repo work (NanoClaw isn't a package in this repo) for no functional gain over the proven standalone gate. Decided to let them stay separate rather than couple a stable production system to a diverging one. No code change; doc + spec updated to reflect this as closed, not blocked.

- [x] Lift NanoClaw write-gate into ActionGate (Step 1): grep-before-building on `/drain-queue-rai` found this already shipped (module lives flat at `packages/core/action-gate.ts`, not the `src/action-gate/` subdir the job text named, functionally equivalent). Verified green: full repo `npm run build` clean, `packages/core` test suite 366/366 passing (includes `action-gate.test.ts`). `89cba87` 2026-04-09 (pre-existing, not built this session)
- [x] YAML policy loader + schema for ActionGate (Step 2): already shipped alongside the shell adapter. `38f45d7` 2026-04-09 (pre-existing, not built this session)
- [x] ActionGate.evaluate() API + unit tests (Step 3): already shipped as part of `89cba87`; `evaluate()` + `Verdict`/`Decision` types present in `action-gate.ts`, covered by `action-gate.test.ts`. Same green verification as Step 1 above. `89cba87` 2026-04-09 (pre-existing, not built this session)
- [x] **ActionGate Steps 5-8** (was in Suggested, resolved same drain pass): shell adapter + Claude Code hook (`action-gate-shell.ts`) `38f45d7` 2026-04-09; MCP adapter (`action-gate-mcp.ts`) `bf4da33` 2026-04-09; also grew beyond spec, Native Messaging Host adapter (`action-gate-native-messaging-host.ts`, OL-140) `72bfb28` 2026-05-02, tamper-proofing (OL-396) `133ea25` 2026-06-21, router-audit adapter (OL-370) `32d44de` 2026-06-21. Not separately verified: docs (spec step 8), `docs/28-rai-actiongate-spec.md` and the code's own header comments still describe shell/mcp as "(planned)"/"TODO", stale given all of this shipped; worth a doc-sync pass if Tim wants the spec current.
- [x] Add a fast `typecheck` script to each package + root, fixed p2-agent's pre-existing red first (bs-council-runner.test.ts type-narrowing) so root typecheck lands clean across all 7 packages. `3b47cfa` 2026-07-20
- [x] Wire `rayScan()` to call `blockReasonFromScanSignals` and attach `block_reason` to blocked verdicts (per Tim's explicit go); commit block-reason v1 module fully green, 22/22 block-reason tests, 281/281 core suite, build+typecheck+test clean across all 7 packages. `44da6d7` 2026-07-20
- [x] RAI extension smoke-test harness (packages/extension, OL-241): vitest smoke that loads the real `npm run build` output (manifest.json + service-worker chunk) with a mocked chrome API, asserts P0 blocks a known injection string end-to-end, and asserts every manifest-declared file exists in dist/. Playwright/real-browser path skipped: not installed, would need a network download (job's own guard). `44eed44` 2026-07-20
- [x] Wire Gate 1 enforcement into P1 scan output (packages/core/rai-scan-p1.ts): extracted `applyGate1()`, downgrades verdict->flagged/caps confidence/forces `human_review` when BS Council verdict is UNVERIFIED or CONTESTED, leaves CONFIRMED/FALSE-ALARM/no-council-ran untouched. 6 new tests, 287/287 core suite, build+typecheck+test green across all 7 packages. Also fixed stale "agents stubbed" claim in CLAUDE.md. `c2a1db3` 2026-07-21
- [x] Delete legacy 4-agent P2 path (packages/p2-agent): removed `scanP2`/`mergeVerdicts`/`consensus.ts`, the `provenance`/`cross-ref`/`temporal` run*Agent wrappers, their tests, the now-dead `P2Result`/`P2Weights` types, and the coupled `P2 Weighted Consensus` describe block in `packages/core/phantom.test.ts`. **Deviation from spec**: kept `src/agents/call-agent.ts` (not deleted) because `credibility.ts`, explicitly required to stay "in full", still calls `callAgent()`; deleting it would have broken the kept file. Deleted `call-agent.test.ts` as instructed since it only tested the removed wrappers. 284/284 core (-3), 63/63 p2-agent (-15), build+typecheck+test green across all 7 packages. `5ca5911` 2026-07-21