# RAI Browser Extension -- Implementation Spec

_Domain file: RAI P1-ext (browser extension)_
_Created: 2026-04-01_
_Status: Pre-implementation_
_Codename: P1-ext (per roadmap in 19-rai-context.md)_
_Target: Chromium Manifest V3 (Chrome, Edge, Brave)_

---

## 1. Project Structure

```
rai-extension/
├── manifest.json
├── tsconfig.json
├── package.json
├── vite.config.ts                    # Vite + CRXJS for MV3
├── src/
│   ├── shared/
│   │   ├── rai-scan-p0.ts            # P0 pattern library (ported from ray-scan.ts)
│   │   ├── rai-scan-p1.ts            # P1 Claude API scan (opt-in, raw fetch)
│   │   ├── types.ts                  # Shared types (ThreatLayer, Verdict, etc.)
│   │   ├── verdict.ts                # resolveVerdict + severityRank logic
│   │   └── constants.ts              # Platform selectors, URL patterns
│   ├── background/
│   │   ├── service-worker.ts         # Main background entrypoint
│   │   ├── scan-coordinator.ts       # Receives scan requests, runs P0, optionally P1
│   │   └── storage.ts                # chrome.storage.local wrapper (API key, scan stats)
│   ├── content/
│   │   ├── injector.ts               # Common content script bootstrap
│   │   ├── observer.ts               # MutationObserver for AI response detection
│   │   ├── clipboard-hook.ts         # Paste event interception
│   │   ├── submit-hook.ts            # Submit/send button interception
│   │   ├── overlay.ts                # Shadow DOM warning overlay renderer
│   │   └── platforms/
│   │       ├── claude.ts             # claude.ai selectors + hooks
│   │       ├── chatgpt.ts            # chatgpt.com selectors + hooks
│   │       ├── gemini.ts             # gemini.google.com selectors + hooks
│   │       └── platform-registry.ts  # Platform detection + adapter dispatch
│   ├── popup/
│   │   ├── popup.html                # Minimal status popup
│   │   ├── popup.ts                  # Status display, P1 API key entry
│   │   └── popup.css
│   └── assets/
│       ├── icons/                    # 16, 32, 48, 128 px
│       └── overlay.css               # Injected warning overlay styles
└── tests/
    ├── p0-patterns.test.ts
    ├── verdict.test.ts
    └── platform-selectors.test.ts
```

---

## 2. Manifest V3

```json
{
  "manifest_version": 3,
  "name": "RAI - AI Interaction Firewall",
  "version": "0.1.0",
  "description": "Ambient protection for every AI interaction. Zero data leaves your device.",
  "permissions": ["activeTab", "storage"],
  "host_permissions": [
    "https://claude.ai/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://gemini.google.com/*"
  ],
  "background": {
    "service_worker": "src/background/service-worker.ts",
    "type": "module"
  },
  "content_scripts": [{
    "matches": [
      "https://claude.ai/*",
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "https://gemini.google.com/*"
    ],
    "js": ["src/content/injector.ts"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": { "16": "src/assets/icons/icon-16.png", "128": "src/assets/icons/icon-128.png" }
  }
}
```

**Permissions rationale:** `storage` for local API key + stats. `activeTab` for matched AI platforms only. No `clipboardRead` needed (paste events via DOM listener). No `webRequest` (DOM-level, not network-level).

---

## 3. Platform Support

| Platform | URL Pattern | Phase |
|---|---|---|
| Claude.ai | `https://claude.ai/*` | MVP |
| ChatGPT | `https://chatgpt.com/*`, `https://chat.openai.com/*` | MVP |
| Gemini | `https://gemini.google.com/*` | MVP |
| Copilot | `https://copilot.microsoft.com/*` | Phase 2 |
| Perplexity | `https://www.perplexity.ai/*` | Phase 2 |

---

## 4. P0 Pattern Library Port

From NanoClaw's `ray-scan.ts`. Ported verbatim:
- `PATTERNS` array (all L-2/L-1/L0 regex patterns)
- `resolveVerdict()` + `severityRank()`
- Type definitions

Adapted:
- `crypto.randomUUID()` (Web Crypto API) replaces Node `randomUUID`
- `isExempt()` removed (no sender/JID concept in browser)
- `rayCheck()` replaced with `scanContent()` returning same verdict structure

Zero Node.js dependencies after port. Runs in any JS runtime.

---

## 5. Content Script Strategy

### Architecture

```
Content Script (injector.ts)
  ├── Detects platform → loads adapter
  ├── clipboard-hook.ts (paste events)
  ├── submit-hook.ts (send button / Enter key)
  ├── observer.ts (MutationObserver on AI responses)
  └── overlay.ts (Shadow DOM warnings)
      ↕ chrome.runtime.sendMessage
Background Service Worker
  ├── scan-coordinator.ts → P0 sync (<5ms)
  ├── P1 opt-in async (fetch to Anthropic API)
  └── Returns merged verdict
```

### Platform Adapter Interface

```typescript
interface PlatformAdapter {
  name: string;
  getInputSelector(): string;
  getSubmitSelector(): string;
  getResponseSelector(): string;
  extractInputText(el: HTMLElement): string;
  extractResponseText(el: HTMLElement): string;
}
```

Adapter pattern isolates DOM breakage to one file per platform.

### Insertion Points

**A. Paste interception:** `paste` event listener, `e.preventDefault()` on blocked, overlay on flagged.

**B. Submit interception:** `click` capture on submit button + `keydown` Enter on input. Scan composed text before send.

**C. AI response scanning:** `MutationObserver` on response container. Detects new assistant messages, scans for L0 (hidden instructions in generated output) and L1 (misinformation, P1 only).

---

## 6. Warning Overlay (Shadow DOM)

- `mode: 'closed'` -- host page JS cannot access or dismiss warnings
- Inline banners anchored to relevant content (not popups/modals)
- Blocked (red): prevents paste, persists until dismissed
- Flagged (amber): warns, auto-dismiss after 8s
- Badge icon: neutral → scanning pulse → red dot on threat

---

## 7. P1 Delivery (Phase 2, not MVP)

P0 ships in all tiers. P1 delivery maps to three pricing tiers:

### Pricing Tiers

| Tier | Name | P1 Engine | Price | Audience |
|---|---|---|---|---|
| Free | RAI Core | P0 only (local regex) | $0 | Everyone. "It just runs." |
| Pro | RAI Local | P0 + local model (WebGPU/ONNX, ~2GB) | Low monthly | Privacy-first users who want L1 misinformation detection without cloud |
| Premium | RAI Cloud | P0 + Claude Sonnet via RAI endpoint | Higher monthly | Maximum protection. RAI manages Anthropic cost + margin. |
| (Hidden) | BYOK | P0 + user's own Anthropic API key | $0 | Developers, geeks. Not promoted on landing page. |

### Tier logic in extension

```
Free:    P0 only → verdict
Pro:     P0 → local model P1 (WebGPU) → merged verdict
Premium: P0 → RAI cloud P1 (Sonnet) → merged verdict
BYOK:    P0 → user API key → merged verdict (hidden in settings)
```

### Implementation notes

- Free/BYOK ship in MVP (P0 is ready, BYOK is a settings field)
- Pro requires WebGPU/ONNX integration + model selection (Phase 2)
- Premium requires RAI backend endpoint + auth + billing (Phase 2)
- Tier selection lives in popup settings, gated by subscription status
- Landing page shows Free/Pro/Premium. BYOK is discoverable in extension settings only.

### GTM tie-in

Tier structure must be reflected on landing page (ray-guard-watch.lovable.app redesign). The "smoke test" for the extension is also a smoke test for pricing willingness. Landing page should capture email + tier interest before extension ships.

---

## 8. Build Tooling

- TypeScript strict, Vite + `@crxjs/vite-plugin`, Vitest
- Zero runtime dependencies
- `npm run dev` (HMR), `npm run build` (dist/), `npm run zip` (CWS upload)

---

## 9. MVP vs Phase 2

### MVP (target: 1-2 weeks)

- P0 local scan (full pattern library)
- Paste + submit interception
- AI response scanning (P0 only)
- Claude.ai + ChatGPT (2 platforms)
- Shadow DOM overlay (blocked + flagged)
- Badge indicator + popup status
- Zero network calls

### Phase 2

- P1 delivery (local model or RAI subscription, GTM decision)
- Gemini + Copilot adapters
- Share/forward detection
- Remote pattern updates (signed, versioned)
- Firefox MV3 port
- Selector auto-repair heuristics
- Onboarding flow + landing page tie-in

---

## 10. Key Decisions

| Decision | Rationale |
|---|---|
| P0 in service worker, not content script | Shared across tabs, no memory duplication |
| Shadow DOM for overlays | Style isolation, security boundary (closed mode) |
| `run_at: document_idle` | AI platforms are SPAs, DOM may not exist earlier |
| P1 via raw fetch, not SDK | Avoids bundling Node SDK, 30-line wrapper sufficient |
| Warn-only default for flagged | False positives destroy consumer trust (spec Q4) |

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Platform DOM changes break selectors | Adapter pattern isolates breakage. Phase 2: heuristic fallback. |
| ProseMirror/Slate paste quirks | May need `beforeinput` event instead of `paste`. Test per platform. |
| P0 false positives on security discussions | "This is my text" dismiss action, suppresses re-scan for session. |
| CWS review rejection | Specific host_permissions only, no `<all_urls>`, clear privacy policy. |

---

## 12. Data Flow

```
USER PASTES → content-script (paste event) → sendMessage → service-worker (P0) → verdict
  clean → no action
  flagged → overlay warning, paste proceeds
  blocked → e.preventDefault(), overlay block

AI RESPONDS → content-script (MutationObserver) → sendMessage → service-worker (P0) → verdict
  clean → no action
  flagged → overlay warning above response
  blocked → overlay block above response (cannot prevent display, warns user)
```
