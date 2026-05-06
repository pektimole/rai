# RAI Mobile Bridge: PWA + Screenshot Capture
_Created: 2026-05-04_
_Status: Spec draft_
_Trigger: Desktop conceptual session 2026-05-04 confirmed four architecture calls (PWA Android first, OCR v0, share-sheet only, accept iOS delete prompt)_
_Dependency: P0 live, P1 live, labelled-corpus schema locked across Telegram bot + Chrome extension_
_Active build OL: OL-186_
_Architecture reference: `spikes/2026-05-04-rai-input-surface-bridges.md`_

---

## 1. Why This Exists

Web surfaces are covered (Chrome extension content scripts + right-click on selection, both shipped). Mobile is not. Mobile cannot use browser content scripts, and URL-fetching the post body server-side is unbuildable at scale (LinkedIn login wall, X locked down, per-platform scraping treadmill).

The user's phone already has the rendered content on screen. The bridge is: **screenshot it, share it to RAI, scan the pixels.**

This spec covers v0 only: PWA on Android via Web Share Target API. IOS Share Extension and OCR-vs-vision hybrid escalation are v1 (see §8).

---

## 2. Architecture Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Platform v0 | **PWA, Android only** | Web Share Target API works on Android Chrome. IOS Safari does not support share targets. Shortest cycle to validate the screenshot-bridge hypothesis. |
| Capture trigger | **Share-sheet only** | Zero new permissions. User screenshots with system shortcut, then shares to RAI. In-app capture would need MediaProjection (Android) or screen-recording (iOS), too intrusive for v0. |
| OCR layer | **On-device OCR, no vision model** | Google ML Kit Text Recognition v2 (free, on-device, ~200ms per image). Cheap, predictable. Loses visual manipulation cues (deepfake artifacts, manufactured-screenshot tells), accepted for v0. |
| Auto-delete UX | **Do not silently delete** | Silent deletion would make RAI a data-loss vector. Offer a button "Delete original screenshot" that triggers the OS confirmation prompt. The prompt is a feature, not a bug. |
| Schema | **Identical to Telegram bot + Chrome extension** | Append-only JSONL, two row types (`scan`, `judgment`) joined by `scan_id`, 3-button label vocabulary (agree / disagree / borderline). |
| Storage v0 | **IndexedDB on device** | Manual JSONL export, drop into `~/.rai/audit/labelled-corpus.jsonl`. Same pattern as Chrome extension. VPS sync deferred. |

Out of scope v0: iOS, vision-model escalation, in-app capture button, automatic VPS sync, provenance metadata recovery from share-payload URL.

---

## 3. PWA Architecture

```
rai-mobile-pwa/
├── manifest.webmanifest # share_target declaration, icons, name
├── service-worker.ts # Offline shell, share-target handler
├── index.html # SPA shell, latest-scan card + label keyboard
├── src/
│ ├── share-handler.ts # Receives POST from share-sheet, extracts image
│ ├── ocr.ts # ML Kit wrapper (or Tesseract.js fallback)
│ ├── pipeline.ts # OCR text -> P0 -> P1 (reuses packages/core)
│ ├── corpus.ts # IndexedDB read/write, JSONL export
│ ├── ui/
│ │ ├── latest-scan.ts # Verdict pill + signals + 3-button keyboard
│ │ ├── label-buttons.ts
│ │ └── delete-prompt.ts # "Delete original screenshot" affordance
│ └── byok.ts # P1 API key entry, mirrors extension popup
└── tests/
 ├── ocr.test.ts
 ├── share-handler.test.ts
 └── corpus-schema.test.ts
```

Scanner code is **ported and adapted** from `packages/extension/src/shared/` (already browser-safe), not imported directly from `packages/core`. The `@rai/core` barrel pulls Node-only deps (`@anthropic-ai/sdk`, MCP SDK, fs) that don't bundle for the PWA. The extension already solved the same problem the same way; the mobile PWA follows that precedent. Concretely: `rai-scan-p0.ts`, `rai-scan-p1.ts`, and `types.ts` are copied into `src/scanner/` with two PWA-specific deltas in P1 (`Channel: mobile`, `Host environment: mobile_pwa` in the user message; BYOK key sourced from `localStorage` instead of `chrome.storage.local`). System prompt, escalation threshold (0.65), verdict merge, and fail-open semantics are byte-for-byte the same so corpus rows from the PWA join cleanly with extension + Telegram lab-bot exports. [amended cd:2026-05-06]

---

## 4. Web Share Target Manifest

```json
{
 "name": "RA(I) Mobile",
 "short_name": "RAI",
 "start_url": "/",
 "display": "standalone",
 "share_target": {
 "action": "/share",
 "method": "POST",
 "enctype": "multipart/form-data",
 "params": {
 "title": "title",
 "text": "text",
 "url": "url",
 "files": [
 { "name": "screenshot", "accept": ["image/png", "image/jpeg"] }
 ]
 }
 }
}
```

The service worker intercepts `POST /share`, pulls the first file from the FormData, and routes it through the OCR pipeline. If the share payload also includes a `url` field (Android often passes both when the user shares from an app that supports rich share), it is harvested as `source_url` metadata on the scan row. Opportunistic only, never required.

---

## 5. OCR Layer

**Choice: Google ML Kit Text Recognition v2 via Capacitor or direct Android intent if going native-shell PWA. Pure-web fallback: Tesseract.js (~3 MB wasm, ~600 ms per image).**

For v0 PWA-only path, use Tesseract.js (no native bridge needed; ships in service worker). Performance is acceptable for share-sheet flow (user already accepts a 1-2 s wait when sharing). Migrate to ML Kit if Tesseract latency becomes an adoption blocker.

Pipeline:

```
ImageBlob (from share payload)
 -> tesseract.recognize(blob, "eng")
 -> { text: string, confidence: number, words: [...] }
 -> normalize whitespace, drop confidence < 0.5 words
 -> string passed to packages/core scanner
```

Edge cases:
- Empty OCR result: surface "Couldn't read text from image. Try a clearer screenshot." Do not call P1.
- OCR confidence < 0.7 average: still scan, but tag `ocr_confidence` on the corpus row so eval-harness can downweight or filter.

---

## 6. Pipeline Reuse

Identical to Chrome right-click handler in `packages/extension/src/background/service-worker.ts:handleRightClickScan`:

1. `scanP0(text)` synchronous regex pass.
2. If `shouldEscalateToP1(p0.verdict, p0.confidence)` and BYOK key present in `localStorage` under `rai-mobile-anthropic-key`: `scanP1(apiKey, text, 'share', p0.verdict, p0Patterns)` async (Haiku, Sonnet escalation at conf < 0.65), then `mergeVerdicts(p0, p1)`.
3. Build scan row, write to IndexedDB `corpus` store.
4. Render verdict + signals + 3-button keyboard in `latest-scan.ts`.
5. On label tap: append judgment row joined by `scan_id`.

The mobile bridge is plumbing on top of the ported scanner. Schema parity is the load-bearing decision; the byte-for-byte identical system prompt + escalation threshold + verdict merge in the port enforce it. [amended cd:2026-05-06]

---

## 7. Corpus Row Shape

Identical to existing schema (locked 2026-05-04). Reproduced for reference:

```jsonl
{"type":"scan","scan_id":"sha256:...","ts":"2026-05-04T18:23:47Z","source":"mobile-pwa","content":"...","content_hash":"sha256:...","verdict":"clean","confidence":0.92,"signals":[...],"p1_model":"claude-haiku-4-5-20251001","latency_ms":1281,"ocr_confidence":0.88,"source_url":"https://www.linkedin.com/posts/..."}
{"type":"judgment","scan_id":"sha256:...","ts":"2026-05-04T18:24:02Z","judgment":"agree"}
```

Mobile-only fields:
- `source: "mobile-pwa"` (vs `"telegram-lab"`, `"extension-rightclick"`, `"extension-content"`)
- `ocr_confidence: number` (averaged from Tesseract per-word confidences)
- `source_url: string | undefined` (opportunistic harvest from share payload)

Five-class derived label still computed at eval time from (verdict, judgment) tuple, never stored.

---

## 8. V1 Roadmap (parked)

Listed for context only; do not build until v0 ships and data justifies.

- **iOS Share Extension (native)**: required because iOS Safari has no share-target. Tim's daily driver, so this comes second after Android PWA validation.
- **Vision-model hybrid**: Claude with image input as escalation path when OCR-driven P1 returns flagged with low confidence, mirrors the P0->P1 escalation pattern. Catches deepfake artifacts and manufactured-screenshot tells that pure OCR misses.
- **In-app capture button**: only if usage data shows users abandon mid-flow at the screenshot step.
- **VPS corpus sync**: opt-in upload to the same endpoint Telegram lab bot will use (OL-187). Manual JSONL drop is acceptable until then.

---

## 9. Threat Model Addendum

Capture surfaces are themselves a threat surface. Documented for completeness; not a v0 blocker.

- **Screenshot bridge as side-channel**: a malicious page rendered in mobile browser, screenshotted by user, scanned by RAI. The attacker now confirms the user runs RAI (via timing of any outbound P1 API call). Low practical impact, no new exposure beyond what the page already had.
- **OCR injection**: an attacker could craft an image whose rendered text contains a prompt-injection payload aimed at P1. P1 already handles arbitrary text, so this is the same attack surface as Telegram forwards; no new mitigation needed.
- **Local corpus exfiltration**: IndexedDB is origin-scoped. PWA running on its own origin protects the corpus from third-party scripts. Manual JSONL export goes through OS share-sheet (user-controlled).

These are L0 reflective-abuse class issues, not blockers.

---

## 10. Implementation Sequence

1. Scaffold `packages/mobile-pwa` workspace, link to `packages/core` via npm workspaces.
2. Manifest + share-target registration. Validate on Android Chrome that the install banner appears and "Share to RA(I)" shows in the share-sheet.
3. Wire service-worker `/share` POST handler. Extract first image from FormData, decode to Blob.
4. Integrate Tesseract.js. Verify OCR on a real LinkedIn screenshot returns recognizable text.
5. Plug OCR output into `runP0` + `runP1` from `packages/core`. Verify verdict + latency + confidence match Chrome right-click on the same content.
6. Render latest-scan card + 3-button label keyboard. Persist to IndexedDB.
7. JSONL export via Blob download (same pattern as extension popup).
8. "Delete original screenshot" button that invokes OS prompt. Do not pre-confirm.
9. Dogfood: Tim shares 20 LinkedIn screenshots through it, drops the export into `~/.rai/audit/labelled-corpus.jsonl`. If schema joins cleanly with extension exports in eval-harness, v0 is done.

---

## Appendix: Surface Coverage After v0

| Surface | Bridge | Status |
|---|---|---|
| Desktop web (any site) | Right-click on selection | Shipped (extension v0.3.0) |
| Desktop web (LLM chats) | Content script DOM hook | Shipped (extension v0.3.0) |
| Mobile web (Android, in-browser) | Share-sheet -> PWA -> screenshot bridge | This spec |
| Mobile native apps (Android) | Share-sheet -> PWA -> screenshot bridge | This spec |
| Mobile (iOS, any) | Native Share Extension | v1 |
| Telegram | Forward text to public bot (P0-only); URL-only forwards out of scope | Shipped (public bot live, lab bot deferred per OL-187) |

Three complementary bridges. None depends on URL-fetching. Schema is identical across all of them.