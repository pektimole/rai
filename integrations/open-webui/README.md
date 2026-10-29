# RA(I) Intake Check for Open WebUI

Runs entirely on your machine. Sends nothing to RA(I).

A Filter Function for Open WebUI (0.12 or newer) that checks content before it reaches your model: what you type or paste, documents you upload, and knowledge chunks Open WebUI retrieves. When something carries hidden instructions or an exposed secret, you get a signal in the chat. You decide what happens. Signal, not verdict.

## What it checks

| Where | Hook | What |
|-|-|-|
| Your message | `inlet` | Injection phrasing, persona overrides, exposed keys and passwords, hidden characters |
| Uploaded files (text already in the request) | `inlet` | Same checks on the extracted text |
| Retrieved knowledge and document context | `request` (after retrieval, before the model) | Same checks on the system message Open WebUI builds |
| The model's reply | `outlet` | Exposed-secret markers only. The reply is never changed |

Checks are the RA(I) P0 pattern floor (generated from `packages/core/rai-scan-p0.ts`, 34 patterns) plus L2 hidden-channel heuristics (zero-width and Unicode-tag characters, bidi overrides, instructions inside HTML comments, image alt text, link titles and base64 blobs).

## What it is not

A pattern and heuristic layer catches the common, cheap, templated injections. A determined attacker can write around it. It is a signal layer, not a guarantee, and the chat copy never says otherwise.

## Install (one path)

1. Open WebUI, Admin Panel, Functions, "+", paste the contents of `rai_intake_check.py` (or import from `https://withrai.xyz/intake-check/rai_intake_check.py`), Save.
2. Enable it, and turn on "Global" so it runs for every model.
3. Optional, per user (chat settings, the function's user valves): `action` = `warn` (default, nothing is changed), `strip` (flagged span removed, rest kept) or `drop` (the item stays out of this turn). `local_log` keeps a counter in `~/.rai/intake-check-log.json` on your disk, off by default.

## Data principle

No network calls. The build script (`scripts/build-open-webui-function.py`) fails if the file imports `requests`, `httpx`, `urllib`, `socket`, `aiohttp` or `http`. Nothing is sent to RA(I), ever.

## Develop

```
npx tsx scripts/export-p0-patterns.ts > integrations/open-webui/p0-patterns.json
python3 scripts/build-open-webui-function.py
python3 integrations/open-webui/test_intake_check.py     # needs pydantic; the Open WebUI venv has it
```

The test runs 8 injected fixtures (must all flag), 20 clean controls (must not flag), the three hooks with every action, the no-network grep, a 20-page latency check (< 50 ms) and a TypeScript-vs-Python parity diff over the P0 labels.

## Status

v0.1.0. Unit-tested against the Open WebUI 0.12.5 hook signatures; live install on a running instance still to be confirmed before guide step 6 points here.
