---
description: Unattended RAI dev-loop drain. Do ONE pending job from rai/queue.md, verify build+test green, commit to the rai repo, stop when empty. Fire as /loop /drain-queue from ~/rai.
---

# /drain-queue: Unattended RAI development loop

Repo-scoped twin of the no5-context `/drain-queue`. This one runs **inside the rai product repo** (`/Users/ich/rai`, github.com/pektimole/rai) and closes jobs by **committing working code**, not by writing OLs/decision-log. It resolves only when cwd = `~/rai` (project command). No5-context files are OUT OF SCOPE here: never touch them from this drain.

Designed to be fired as **`/loop /drain-queue`** so each job runs in a fresh context (accurate disk state). Standalone `/drain-queue` also works: one job, then report.

Firing this over the queue IS Tim's Phase B `go` for each job's commit. He is away. Do not ask him anything mid-run; use the **Blocked** bucket instead.

## Per invocation

1. **Fresh-state check.** `cd /Users/ich/rai`. Read `queue.md`. `git fetch origin main && git rebase --autostash origin/main` first (a parallel session may have shipped or added jobs). If rebase conflicts, stop and Block the run with the conflict.

2. **Sweep Suggested → Pending.** For each item under `## Suggested`, apply the identical gate from step 6, PLUS: anything tagged `[DESIGN-PROPOSAL]` or a genuine architecture/scope fork never auto-promotes (P2 consensus design, threat-layer schema changes, brand/deck copy, API-surface breaking changes all count). Everything else that passes: move the line, unchanged, to the bottom of Pending. Non-passing/design items stay in Suggested, untouched, no Blocked entry. If anything moved, commit `queue.md` alone (`chore(queue): promote suggested`) before continuing.

3. **Empty?** If **Pending** has no `- [ ]` items: batch done. Emit the final report (table of Done + Blocked this batch with commit refs, plus a count of anything left in Suggested). **Stop the loop.** End here.

4. **Green baseline.** Before touching code, confirm the repo is currently green for the package(s) the job touches: `npm run build` (or scoped `npm run build -w packages/<pkg>`) and `npm test` if the package has tests. If the baseline is already RED before you start, do NOT stack a change on top, Block the top job with "baseline red: <failing pkg/test>" so a broken tree is surfaced, not buried. (Exception: if the top job IS "fix the red baseline", proceed.)

5. **Take the TOP pending job.** One job only.

6. **Gate it BEFORE doing anything.** Do NOT execute, move to **Blocked** with the exact question, commit `queue.md` only, continue, if the job would:
 - publish to the Chrome Web Store / any store, deploy to the VPS or any live host, or push a package to a registry (npm publish);
 - send / post / DM externally, submit a form, or accept terms;
 - touch `.env`, secrets, keys, `_vendored/` scp pulls, or any credential;
 - delete or overwrite a file not created in this run, or rewrite git history;
 - spend money or hit a paid/external API for anything beyond the repo's own already-configured test keys;
 - make a breaking change to a locked vocabulary/schema (e.g. `block-reason.ts` reason codes, P2 consensus contract) without an explicit compat path stated in the job;
 - hit a genuine decision fork with no safe default.
 Never guess on these.

7. **Grep before building.** `ls`/grep for the target artifact first: a parallel session may already have shipped it (this exact miss cost two no5 sessions). If already done, mark it done with a note, skip.

8. **Do the job fully.** Real code. Match repo conventions: TypeScript, workspace layout, existing file idiom. Follow `CLAUDE.md` (P0=local regex zero-cost, P1 Haiku→Sonnet<0.65, brand `(R)AI`/RAI/"Ray"). If the job adds behavior, add or extend a vitest test for it in the same package.

9. **Verify green: this is the close gate.** Re-run `npm run build` and `npm test` for every touched package (root `npm run build && npm test` if the change spans packages). **Both must pass.** If either fails and you cannot fix it within the job's scope, `git checkout, .` / `git restore` the working changes (leave the tree exactly as green as you found it), move the job to **Blocked** with the failing output summary, commit `queue.md` only, and continue. Never commit a red tree. No silent "mostly works".

10. **Commit atomically.** `git add` only the files this job touched (never `git add -A` blind: the tree may hold unrelated WIP; check `git status` and stage deliberately). One conventional commit matching repo style: `feat(<pkg>): <what>` / `fix(<pkg>): <what>` / `test(<pkg>): <what>` / `docs: <what>`, with a `[drain]` marker in the body and the OL ref if the job carries one. Push: `git fetch origin main && git rebase --autostash origin/main && git push origin main`, retry on non-fast-forward. If push keeps failing, leave the commit local and note it in the report (do not force-push).

11. **Update the queue.** Move the job's line from Pending to **Done** as `- [x] <job>, <commit-hash> <date>`. Commit `queue.md` (`chore(queue): close <short job>`).

12. **Next.** Pending still has jobs → loop to step 1. Empty → step 3.

## Guardrails
- One job per invocation, one code-commit per job (+ its queue.md commit). Never batch, never parallel.
- **A red build or failing test is an automatic hold, not a judgment call.** Restore-to-green + Block.
- Scope is the rai repo ONLY. RAI OLs/decision-log live in no5-context and are closed there, not here. If a job's real closure needs a no5-context OL write, do the code half, commit it, and Block the OL half with "needs no5-context /close: OL-XXX".
- If a job needs a higher model tier (deep architecture, P2 consensus reasoning, threat-model judgment), do the safely-doable slice, Block the rest with "needs Opus/Fable: <why>".
- Report honestly: failed/skipped/blocked jobs say so with the reason. No silent drops.

## Final report format
```
RAI dev-loop drained (N jobs): X shipped, Y blocked, Z skipped. Tree: green.
| Job | Outcome | Commit / Reason |
|-----|---------|-----------------|
...
Blocked jobs need your input, see queue.md Blocked.
```