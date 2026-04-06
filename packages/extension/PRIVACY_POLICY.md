# RAI Privacy Policy

**Last updated:** 2026-04-06

## Data Collection

RAI collects **no data**. Zero data leaves your device.

## How RAI Works

RAI scans AI chat interfaces (Claude, ChatGPT, Gemini) for prompt injection, credential exposure, and other threats using local pattern matching. All scanning runs entirely in your browser using a regex-based engine. No text is sent to any server, API, or third party.

## Storage

RAI stores the following data locally in your browser via `chrome.storage.local`:

- **Scan count**: total number of messages scanned (integer)
- **Threat count**: total number of threats detected (integer)
- **Strict mode preference**: whether strict mode is enabled (boolean)

This data never leaves your browser.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read AI chat content to scan for threats |
| `storage` | Persist scan stats and user preferences locally |
| Host permissions (claude.ai, chatgpt.com, gemini.google.com) | Inject content scripts on supported AI platforms |

## Third-Party Services

RAI makes **no network requests**. There are no analytics, telemetry, crash reporting, or external API calls.

## Contact

Tim-Ole Pek -- tim@around.capital
