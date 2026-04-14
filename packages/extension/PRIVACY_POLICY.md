# RAI Privacy Policy

**Last updated:** 2026-04-15
**Extension name:** RAI - AI Interaction Firewall
**Extension ID:** gcjplnikihpnkakjkggaikhbdphlipon
**Developer:** Tim-Ole Pek

---

## Summary

RAI is a privacy-first AI interaction firewall. The Free tier operates entirely locally — no data leaves your device. The optional Pro tier (BYOK, user's own Anthropic API key) sends scanned message content to Anthropic via your key, for enhanced threat detection. RAI itself operates no servers, collects no analytics, and has no backend. Every network call is initiated by your configuration choice, not by us.

---

## 1. Data Collection

### Free tier (default)
RAI collects **no data**. All threat scanning runs locally in your browser using regex pattern matching. No message content, URLs, or metadata is transmitted to any server, including ours.

### Pro tier (BYOK — Bring Your Own Key, user opt-in)
If you enter an Anthropic API key in the extension popup, RAI will:
- Read the content of messages you type, paste, or receive on supported AI platforms (Claude.ai, ChatGPT, Gemini)
- Send that content directly to Anthropic's API (`api.anthropic.com`) using **your** API key, for classification by Claude Haiku
- Receive the classification result and render it as a warning overlay in your browser

RAI **never** sees or proxies this traffic. The request goes directly from your browser to Anthropic using your key. RAI operates no servers.

You enable this mode by choice. Remove the key from the popup at any time to return to Free tier behavior.

---

## 2. Data Handling

### Local processing (Free + Pro)
- Message content is read from the active AI platform's DOM (only on supported domains, see Permissions)
- Regex pattern matching runs in the extension's service worker
- Scan results (verdicts, threat layers, confidence) are rendered as overlays in the same page — never exfiltrated
- Scan counters are incremented in `chrome.storage.local`

### External processing (Pro tier only, user-initiated)
- When P1 (Pro) scanning is active and a message triggers escalation, the message content is sent to Anthropic's API
- Anthropic's own privacy policy governs this transmission: https://www.anthropic.com/legal/privacy
- RAI has no visibility into this traffic, does not log it, does not proxy it, and does not store the response beyond the immediate scan verdict
- If the API call fails, RAI "fails open" — the Free tier verdict stands, no error data is retained

---

## 3. Data Storage

RAI stores the following data locally in your browser via `chrome.storage.local`. This data never leaves your device and is removed when you uninstall the extension:

| Data | Purpose | Retention |
|---|---|---|
| Scan count (integer) | Show total scans in popup UI | Persisted until uninstall or manual reset |
| Threat count (integer) | Show total threats detected in popup UI | Persisted until uninstall or manual reset |
| Strict mode preference (boolean) | Remember your block-on-critical setting | Persisted until uninstall or manual change |
| Anthropic API key (string, Pro tier only, optional) | Authenticate P1 scans against Anthropic API | Persisted until uninstall or manual removal via popup |

**No message content is stored.** Scans are evaluated in-memory and the verdict is rendered to the page; the message itself is not retained.

**API keys are stored in `chrome.storage.local`**, which is scoped to the extension and isolated from other extensions and websites per Chrome's security model. RAI never transmits your API key to any party other than Anthropic when executing a P1 scan on your behalf.

---

## 4. Data Sharing

RAI does not share your data with any third party except in the following narrow, user-initiated case:

### Anthropic (Pro tier only, when you provide an API key)
When you opt into P1 scanning by providing your own Anthropic API key, RAI sends message content to `api.anthropic.com` for classification. This is a direct browser-to-Anthropic connection using your key. Anthropic's handling of this data is governed by their privacy policy.

### No other sharing
RAI does **not**:
- Send data to any RAI-operated server (we operate none)
- Use analytics, telemetry, crash reporting, or user tracking
- Share data with advertisers, data brokers, or partners
- Sell data
- Transmit data for any non-scanning purpose

---

## 5. Permissions

| Permission | Why it's requested |
|---|---|
| `storage` | Persist scan stats, preferences, and (optional) BYOK key in `chrome.storage.local` |
| Host permissions (`claude.ai`, `chatgpt.com`, `gemini.google.com`) | Inject content scripts to scan AI chat interfaces |
| `https://api.anthropic.com/*` (Pro tier only) | Enable direct P1 scan calls when user provides Anthropic API key |

RAI requests no other permissions. No `activeTab` for arbitrary sites, no `tabs` API for browsing history, no `cookies`, no `history`, no `downloads`.

---

## 6. User Rights and Controls

- **Revoke BYOK:** Remove your Anthropic API key from the extension popup at any time. Pro tier scanning stops immediately.
- **Reset stats:** Uninstall and reinstall the extension to clear scan/threat counters and all stored preferences.
- **Disable the extension:** Turn it off in `chrome://extensions` — no scanning occurs while disabled.
- **Uninstall:** All locally stored data is removed when you uninstall the extension.
- **EU users (GDPR):** You have the right to access, rectify, erase, and port your data. Since RAI stores no personally identifying data on any server we operate, these rights are exercised by uninstalling the extension, which removes all data.
- **California users (CCPA):** Same as above. We do not sell personal information.

---

## 7. Children's Privacy

RAI is not directed at children under 13 and does not knowingly collect data from them. Since the extension operates no server and collects no data in the Free tier, there is no mechanism by which we could receive data from any user, child or adult.

---

## 8. Changes to This Policy

We may update this policy to reflect changes in the extension's functionality. Material changes will be reflected in the extension's version history and a new `Last updated` date above. Continued use of the extension after an update constitutes acceptance of the revised policy.

---

## 9. Open Source

RAI is open source. You can audit every line of code that handles your data at:
https://github.com/pektimole/rai

This privacy policy accurately describes the behavior implemented in the code. Any discrepancy between this policy and the code should be reported as a bug.

---

## 10. Contact

For privacy-related questions, data requests, or security disclosures:

**Tim-Ole Pek**
Email: tim@around.capital
Repository: https://github.com/pektimole/rai/issues

---

## 11. Jurisdiction

This policy is governed by the laws of Switzerland, where the developer is established. EU users retain all rights granted by the GDPR regardless of jurisdiction clause.
