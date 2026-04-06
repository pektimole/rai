# CWS Listing Copy

## Store Name
RAI - AI Interaction Firewall

## Short Description (132 char max)
Ambient protection for every AI interaction. Scans for prompt injection, credential leaks, and threats. 100% local, zero data sent.

## Detailed Description

RAI is a browser extension that scans your AI conversations in real time for security threats. It runs entirely on your device with zero network calls.

**What it detects:**
- Prompt injection attacks (jailbreaks, role overrides, instruction manipulation)
- Credential and secret exposure (API keys, tokens, passwords in AI responses)
- Infrastructure threats (supply chain indicators, model poisoning signals)

**Supported platforms:**
- Claude (claude.ai)
- ChatGPT (chatgpt.com)
- Google Gemini (gemini.google.com)

**Privacy first:**
- Zero data leaves your device. All scanning uses local pattern matching.
- No analytics, no telemetry, no external API calls.
- Open source: https://github.com/pektimole/rai

**Strict Mode:**
Enable strict mode to block paste operations when critical threats are detected, preventing you from accidentally sending compromised prompts.

**How it works:**
RAI injects a lightweight content script on supported AI platforms. Every message (inbound and outbound) is scanned against a pattern engine covering three threat layers: infrastructure/supply chain (L-2), model integrity (L-1), and prompt injection (L0). Threats are surfaced as inline overlays with severity and explanation. No AI model is used for scanning in the free tier.

## Category
Developer Tools

## Language
English

## Website
https://github.com/pektimole/rai

## Privacy Policy URL
https://github.com/pektimole/rai/blob/main/packages/extension/PRIVACY_POLICY.md
