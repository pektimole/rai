# RAI Landing Page Brief for Lovable
_Feed this to Lovable for the ray-guard-watch.lovable.app redesign._
_Last updated: 2026-04-09_

---

## Brand

- Visual: **RA(I)**
- Plain text / URLs: **RAI**
- Pronounced: **"Ray"**
- Tagline: **Ambient protection for every AI interaction.**
- One-liner: The first AI firewall that protects what you say, what your AI reads, and what your agent is allowed to do.

---

## What RAI Does (3 pillars)

### 1. Content Firewall (P0 + P1)
Scans everything entering and leaving AI conversations for threats.

| Layer | What it catches | How |
|---|---|---|
| L-2 | Infrastructure attacks (MCP injection, context file manipulation, credential exfiltration) | Regex patterns, instant |
| L-1 | Model poisoning (persona replacement, behavioral drift, system prompt injection) | Regex + Claude API |
| L0 | Prompt injection (jailbreaks, instruction override, leaked API keys) | Regex + Claude API |
| L1 | Misinformation (hallucination amplification, false claims stated as certain) | Claude API only |

- P0 (regex): <5ms, runs locally, zero data leaves device
- P1 (Claude API): Haiku default, auto-escalates to Sonnet on low confidence

### 2. Multi-Agent Consensus (P2)
Four independent AI chains verify claims before they reach you:

| Agent | What it checks |
|---|---|
| Provenance | Source authenticity, origin chain integrity |
| Cross-reference | Claim consistency across multiple sources |
| Temporal | Timeline coherence, outdated information |
| Credibility | Source tier scoring, authority weighting |

All four must agree. Disagreement = flag for human review.

### 3. ActionGate (L4) -- Agent Action Firewall
Stops agents from doing things they shouldn't, even with trusted outputs.

| Surface | What it gates | Status |
|---|---|---|
| File system + Git | Write/commit/push operations | Production (7+ months) |
| Shell commands | exec/spawn in Claude Code, Cursor, Aider | Live (Claude Code hook) |
| MCP servers | Any tool invocation via MCP protocol | Ready (transparent proxy) |
| HTTP | Fetch, mutation verbs | Planned |
| Browser DOM | Form submit, click, navigate | Planned |

Policy-driven (YAML), fail-closed, zero LLM calls, microseconds.
"Your AI firewall doesn't just decide what your model reads. It decides what your model is allowed to do."

---

## Chrome Extension (CWS approved, live)

### What it does
- Runs on **Claude.ai, ChatGPT, Gemini** (all 3 major AI platforms)
- Scans **pastes** (before they enter the chat)
- Scans **submissions** (before you hit send)
- Scans **AI responses** (flags suspicious output)
- Shadow DOM overlays: red banner (blocked), yellow banner (flagged)
- Send blocker: prevents sending blocked content until user acknowledges
- Badge indicator on extension icon (green/orange/red)

### Features by tier

| Feature | Free | Pro (BYOK) |
|---|---|---|
| P0 regex scan (22 patterns, 3 threat layers) | Yes | Yes |
| Paste interception | Yes | Yes |
| Submit blocking on critical threats | Yes | Yes |
| AI response scanning | Yes | Yes |
| Shadow DOM warning overlays | Yes | Yes |
| Strict mode (block paste entirely on critical) | Yes | Yes |
| P1 Claude API deep scan | -- | Yes |
| Haiku + Sonnet auto-escalation | -- | Yes |
| L1 misinformation detection | -- | Yes |
| Merged P0+P1 verdict (higher severity wins) | -- | Yes |

### How BYOK works
1. User enters their Anthropic API key (sk-ant-*) in extension popup
2. Flagged/uncertain P0 results auto-escalate to P1
3. P1 calls Anthropic Messages API directly from the extension
4. Fail-open: if API call fails, P0 verdict stands
5. Key stored locally in chrome.storage.local, never transmitted to RAI

### Stats in popup
- Total scans counter
- Threats detected counter
- P0/P1 badge (shows active scan mode)
- Strict mode toggle

---

## Pricing (3 tiers)

| Tier | Name | What | Price |
|---|---|---|---|
| Free | RAI Core | P0 local regex scan. Zero data leaves device. | $0 |
| Pro | RAI Pro | P0 + P1 (BYOK). ActionGate shell + fs-git policies. | Low monthly |
| Premium | RAI Premium | P0 + P1 (managed). P2 multi-agent consensus. All ActionGate adapters + audit log. | Higher monthly |

BYOK (hidden tier): Free extension + user's own Anthropic API key. Not promoted on landing page, discoverable in extension settings.

---

## Technical specs (for FAQ / trust section)

- **Zero data leaves your device** on Free tier (all regex, all local)
- **No account required** for Free tier
- **Manifest V3** (latest Chrome extension standard)
- **Open source**: github.com/pektimole/rai
- **4 supported platforms**: Claude.ai, ChatGPT, chat.openai.com, Gemini
- **22 regex patterns** across 3 threat layers
- **Fail-open design**: errors never block user workflow
- **Policy-as-code**: YAML config, version-pinned, hot-reloadable
- **87 tests** in core package, integration-tested through full proxy pipeline

---

## Competitive positioning

| | RAI | Lakera | Protect AI | Rebuff |
|---|---|---|---|---|
| Consumer extension | Yes | No | No | No |
| Agent action firewall | Yes (ActionGate) | No | No | No |
| Multi-agent consensus | Yes (P2) | No | No | No |
| MCP server gating | Yes (proxy) | No | No | No |
| Local-first (zero cloud) | Yes (Free tier) | No | No | No |
| Open source | Yes | No | Partial | Yes |

RAI is the only product that covers the full stack: content scanning + action policy + multi-agent verification, from browser to CLI to server.

---

## Call to action

Primary: **Install Chrome Extension** (CWS link)
Secondary: **Get early access** (email capture for Pro/Premium)
Tertiary: **Star on GitHub** (github.com/pektimole/rai)

---

## Visual direction

- Dark mode preferred (matches developer/AI audience)
- Threat layer visualization (L-2 through L4, color-coded)
- Live demo section showing overlay in action (screenshot or animation)
- Trust signals: open source, zero data, Manifest V3, test count
