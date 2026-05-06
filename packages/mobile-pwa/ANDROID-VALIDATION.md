# Android Share-Target Validation

The PWA's manifest declares `share_target`, but Android Chrome only adds RA(I) to the system share-sheet **after the user installs the PWA**. PWA install requires a valid TLS cert (the dev `basic-ssl` self-signed cert is rejected by Chrome's installability check).

Two paths from a clean `vite build`:

## Path A: ngrok tunnel (zero deploy)

```bash
cd packages/mobile-pwa
npm run build
npx serve dist -p 5174 &
ngrok http 5174
```

Open the `https://<id>.ngrok.app` URL on the Android phone. Install banner should appear. Once installed, take a screenshot inside any app, tap Share, RA(I) should be in the share-sheet.

## Path B: Vercel preview deploy

```bash
cd packages/mobile-pwa
npm run build
npx vercel deploy dist --prod=false
```

Vercel hands back an `https://rai-mobile-pwa-<hash>.vercel.app` preview URL. Same Android install + share-sheet check.

## What to check

1. **Install banner appears.** If not, open Chrome devtools (remote-debug from Mac) → Application → Manifest → look for installability errors.
2. **Manifest carries `share_target`.** Devtools → Application → Manifest, scroll to "Share target".
3. **Share-sheet entry shows "RA(I)".** Take a screenshot in another app, hit Share. RA(I) icon visible.
4. **Pipeline runs end-to-end on share.** Tap RA(I) from the share-sheet. PWA opens, SW intercepts `POST /share`, stages the image in IndexedDB, and redirects to `/?share=<id>`. Console shows three log lines back-to-back: `[rai-mobile] pending share picked up { bytes, type, source_url, ... }`, `[rai-mobile] ocr { chars, word_count, ocr_confidence, duration_ms, preview, ... }`, then `[rai-mobile] p0 { scan_id, verdict, confidence, signals, ... }` (and a `[rai-mobile] p1 { ... }` line if a BYOK key is set and P0 escalation criteria are met). First OCR pulls the Tesseract worker + `eng.traineddata` from CDN (~3-5 MB, cached by SW under `rai-mobile-tesseract-v1` for 90 days); subsequent OCRs run from cache.
5. **Latest-scan card renders.** The `#empty-state` section disappears and `#latest-scan` shows a verdict pill (clean / flagged / blocked, color-coded), confidence, the OCR'd content snippet, the threat-layer signal list, the explanation, and a meta line (`<timestamp> · P0 only` or `<timestamp> · P1 haiku <ms>ms · OCR <conf>`). Devtools → Application → IndexedDB → `rai-mobile` → `corpus` should contain a fresh `scan` row with `type: "scan"`, `source: "mobile-pwa"`, the full schema (`content_hash` is `sha256:<hex>`), and the `source_url` if Android passed one through.
6. **Label keyboard persists a judgment row.** Tap one of the three buttons (👍 agree / 👎 disagree / 🤷 borderline). The row collapses to `✓ labelled: <choice>` and the corpus footer line increments. A second `corpus` IDB row appears with `type: "judgment"`, the same `scan_id`, and the chosen judgment. Tapping again is a no-op (the row stays in confirm state).
7. **BYOK toggle.** Paste a `sk-ant-…` key in the BYOK section, tap Save. The header badge flips from "P0 only" → "P0 + P1" (green). Run a new scan that should escalate (e.g. share a screenshot containing AI-provenance fingerprints): the second console line for that scan should be `[rai-mobile] p1 { ... }` and the `scan` row should have `p1_invoked: true` plus `p1_model` / `p1_latency_ms`. Tap Remove to clear; the badge flips back.
8. **JSONL export.** Tap "Export labelled corpus (JSONL)". A file `rai-mobile-corpus-<timestamp>.jsonl` downloads. Each line is one row; `scan` and `judgment` rows are joined by `scan_id`. Drop into `~/.rai/audit/labelled-corpus.jsonl` and the eval-harness should ingest it the same as extension exports.

## Mac local dev (different goal)

For iterating on UI / scanner logic without Android, `npm run dev` over `https://localhost:5174` (self-signed) works. Chrome will warn on the cert; click through. PWA install won't be offered, but the SPA + service worker run normally.