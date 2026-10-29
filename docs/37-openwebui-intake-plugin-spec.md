# 37 · Open WebUI intake-check plugin, spec v0.1 (OL-660)

_Status: BUILT v0.1.0 [cd:2026-10-30], live-install test pending. Was: SPEC, not built. Author: No5 [cd:2026-10-29]. Parent: OL-649 (withrai.xyz/own funnel). This plugin is guide step 6 ("Switch on RAI's intake check"); until it ships, step 6 is a waitlist._

## 1. Goal

Give a self-hoster running Ollama + Open WebUI one install step that checks content **before it reaches the model's context or the knowledge store**, and shows a signal the user acts on. Signal, not verdict (Constitution Rule 1). Optionality, not protection (Rule 2).

## 2. Scope v1

| In | Out (later) |
|-|-|
| Chat messages entering context (user turn incl. pasted text) | Weight / fine-tune guarding (HORIZON) |
| Uploaded files after Open WebUI text extraction (PDF, DOCX, TXT, MD) | P1 cloud escalation (Haiku-class) |
| Web-fetch / RAG chunks injected by Open WebUI before the model call | ActionGate on tool execution (separate surface) |
| Model output scan for credential/exfil markers (L-2 call-leg equivalent) | Multi-user admin dashboards |

## 3. Integration point

Open WebUI **Filter Function** (Admin Panel > Functions, installable from a single `.py` file or URL). Hooks:
- `inlet(body)`: runs before the request reaches the model. Scans the latest user message plus any `files`/RAG context present in the body.
- `outlet(body)`: runs on the model response. Scans for L-2 markers only.

Alternative considered: Open WebUI **Pipelines** server (separate container). Rejected for v1: second container breaks the "one path" install promise of the guide. Revisit if Filter Functions cannot see RAG chunks. [VERIFY on build: which body fields carry retrieved chunks and uploaded-file text in the current Open WebUI release; pin that release in the guide.]

## 4. Engine

RAI core is TypeScript (`packages/core/rai-scan-p0.ts` `rayScan`, `repo-scan.ts` L2 hidden-channel checks); Open WebUI functions are Python. Two options:

| Option | How | Pro | Con |
|-|-|-|-|
| A. Python port of P0 | Port the P0 pattern library + L2 hidden-channel heuristics (zero-width, bidi, CSS-hidden text markers in extracted text, split payload) into the `.py` | One file, no extra process, fully offline | Two codebases to keep in sync; needs a parity test against `rai-scan-p0.test` fixtures |
| B. Local RAI daemon | Filter calls `http://127.0.0.1:<port>/scan` on a small Node service wrapping `rayScan` | Single source of truth | Second install step, a running process, breaks "one path" |

**Recommendation: A for v1**, generated from the TS pattern library by a build script (patterns exported as JSON from `rai-scan-p0.ts`, embedded into the `.py` at release), plus a CI parity test running both engines over the same fixtures. B stays the path once a RAI desktop agent exists.

## 5. User experience

- On a signal, the filter does **not** silently block. It prepends a short notice to the model context and shows a status message in the chat: `RA(I) signal · L0 · hidden instruction in "invoice_march.pdf": asks the assistant to forward emails. Kept out of this answer. [Use anyway]`
- Default action per signal class is a user valve (Function settings): `warn` (default) | `strip` (remove flagged span, keep rest) | `drop` (exclude the item from context).
- Nothing is written to memory/knowledge from a flagged item unless the user chose `Use anyway`.
- Valves are per user, not hidden admin policy.

## 6. Data principle (hard constraint)

Per 19-rai-context.md Constitution Addendum [cd:2026-10-29]:
- **No network calls at all in v1.** Grep-enforced in CI: no `requests`, `httpx`, `urllib`, `socket` imports in the shipped `.py`.
- Local log (optional valve, off by default): counts per signal type on the user's machine only, for the user's own weekly view.
- README and the function description state in the first line: "Runs entirely on your machine. Sends nothing to RA(I)."

## 7. Honest-layer note (keep in README, out of marketing)

P0/L2 are pattern and heuristic checks: a signal layer, evadable by a determined attacker (detector-generator asymmetry). They catch the common, cheap, templated injections (the IPI-in-the-wild class). They are not a guarantee.

## 8. Acceptance criteria v1

1. Install from one URL in Admin Panel > Functions; enable globally; works on the pinned Open WebUI release with an Ollama 7-8B model.
2. Fixture suite: white-text PDF injection, zero-width-char payload, HTML-comment instruction in a fetched page, base64 split payload, clean controls. Target: flags all injected fixtures, 0 flags on 20 clean documents (business PDFs, recipes, code).
3. Added latency per message < 50 ms on a 2023 laptop for a 20-page PDF.
4. CI: parity test TS vs Python on shared fixtures; no-network grep check.
5. Guide step 6 updated from waitlist to install instructions; /own Set up card can then drop "early access" wording.

## 9. Open questions for Tim

- Distribution: Open WebUI community function listing vs withrai.xyz download only (listing = reach, but a third-party store page we must keep honest).
- Naming inside Open WebUI ("RA(I) Intake Check").
- License for the `.py` (MIT for adoption vs source-available).

Cross-ref: OL-649, OL-660, OL-453 (L2 hidden-channel heuristics), OL-301 (result-path inspection, same posture), 19-rai-context.md self-hosters wedge [mob:2026-04-21] + Constitution Addendum [cd:2026-10-29].

## 10. Build note v0.1.0 [cd:2026-10-30]

Built per section 4 Option A. Files: `integrations/open-webui/rai_intake_check.py` (the Function), `p0-patterns.json` + `scripts/export-p0-patterns.ts` + `scripts/build-open-webui-function.py` (generated pattern block, no-network grep), `fixtures.json` + `test_intake_check.py` (8 injected / 20 clean / hooks / latency / parity), `scripts/scan-fixtures.ts` (TS side of parity). Hosted copy for one-URL install: `assets/landing/intake-check/rai_intake_check.py`.

Resolved on build, the section 3 VERIFY item: Open WebUI 0.12.5 runs `inlet` filters BEFORE `chat_completion_files_handler` (retrieval), so inlet cannot see RAG chunks. It also exposes a `request` filter hook that runs AFTER retrieval and before the model call; the retrieved chunks and document context sit in the system message at that point. v1 uses `inlet` (user message + any inline file text) plus `request` (system message), plus `outlet` (L-2 only, reply untouched). Pipelines server not needed.

Deviation from section 5: no inline "Use anyway" button (Filter Functions have no per-message UI). Replaced by the user valve `action` = warn (default, nothing changes) | strip | drop; strip/drop notices say what was withheld and how to re-send. Signal text goes out as a status line plus a notification event.

Results: 8/8 injected fixtures flagged, 0/20 clean controls flagged, parity 28/28 on P0 labels, 20-page text scan 22 ms, no-network check pass, core tsc clean, rai-scan-p0 tests 7/7.

Open before guide step 6 flips from waitlist to install: live install on a running Open WebUI 0.12.5 (uvx path from the guide), confirm the `request` hook sees the `<source>` context for an uploaded PDF and a knowledge collection, confirm the status/notification events render in the chat UI.
