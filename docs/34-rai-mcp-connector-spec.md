# RAI MCP Connector, Spec
_OL-404 | Created: 2026-06-23 | Status: Draft_

---

## 1. Why This Exists

RAI has 78/78 tests green across 4 packages. The constraint is not build depth: it is distribution. Zero external users.

The Claude Code MCP connector is a zero-CAC distribution path that puts RAI in front of the exact ICP:

| Factor | Signal |
|---|---|
| Who uses Claude Code | Security-aware developers, AI builders, power CLI users |
| Who cares about agent safety / prompt injection | The same group |
| RAI ICP | Developer teams running AI agents with tool access |
| Cost to reach them via MCP | One URL in `claude_desktop_config.json` or Claude Code settings |

**Distribution mechanic:** A developer adds `rai` as a remote MCP server. Claude can now call `rai_scan`, `rai_actiongate_check`, etc. As tools in any conversation or agent loop. Every call = logged usage event = dashboard data = enterprise sales signal.

There is no funnel. The product is the distribution.

---

## 2. Two Distinct Surfaces (Don't Conflate)

RAI already has `mcp-proxy.ts`: that is **outbound**: RAI wrapping a *downstream* MCP server to gate its tool calls. That is the ActionGate/L4 product for paying teams.

OL-404 is **inbound**: RAI *becoming* an MCP server that exposes its scan tools to Claude Code users. Different direction, different audience, same codebase.

```
[Claude Code user]
 │ MCP over HTTP (SSE or streamable)
 ▼
[RAI MCP Server: hosted on Hetzner / Netlify fn]
 │ calls
 ▼
[packages/core: rayScan (P0) + scanP1 (P1) + evaluateMcp (ActionGate)]
 │ logs
 ▼
[ingest-server → scan-log → dashboard telemetry]
```

---

## 3. Tool Surface

Four tools. Each maps directly to an existing RAI function.

### 3.1 `rai_scan`

**What:** Full P0+P1 scan of arbitrary text content. P0 always runs (regex, free). P1 runs when P0 flags or caller requests it.

**Maps to:** `rayScan()` + `scanP1()` in `packages/core`

**Input schema:**
```json
{
 "content": "string: the text to scan (max 32k chars)",
 "channel": "browser | clipboard | email | telegram | whatsapp | artifact | api",
 "pipeline_stage": "ingest | process | output | display",
 "tier": "p0 | p1 (default: p0)",
 "origin_url": "string | null, URL this content came from",
 "session_id": "string: caller's session identifier (opaque)"
}
```

**Output schema:**
```json
{
 "scan_id": "uuid",
 "verdict": "clean | flagged | blocked",
 "confidence": "0.0–1.0",
 "recommended_action": "pass | warn | quarantine | block",
 "threat_layers": [
 { "layer": "L0", "label": "Prompt injection", "signal": "...", "severity": "high" }
 ],
 "explanation": "2-sentence plain-English: what was detected + why it matters.",
 "tier_used": "p0 | p1",
 "learn_more_url": "https://ray-ai.com/threats/L0  (dashboard deep-link for this layer)",
 "latency_ms": 42
}
```

**Auth:** P0 = no key required. P1 = requires `RAI_CLAUDE_KEY` header (BYOK) or Pro subscription token.

**Note:** explanation is inline (the former `rai_threat_explain` tool, folded in). `learn_more_url` is the education-to-signup hook on every response.

---

### 3.2 `rai_judge`

**What:** Go/no-go gate. Same backend as `rai_scan` but output collapsed to a decision the caller acts on directly. For agent loops that need "should I proceed?" not a full diagnostic.

**Maps to:** `scripts/rai-judge.py` logic over `rayScan()` + `scanP1()`. P0 fast-path; escalates to P1 when P0 confidence < 0.65. No BS Council (too slow for a pre-action gate).

**Input schema:**
```json
{
 "content": "string: the text to judge (max 32k chars)",
 "channel": "browser | clipboard | email | telegram | whatsapp | artifact | api",
 "tier": "p0 | p1 (default: p0, auto-escalates on low confidence)",
 "session_id": "string: caller's session identifier (opaque)"
}
```

**Output schema:**
```json
{
 "verdict": "clean | flagged | blocked",
 "proceed": true,
 "confidence": "0.0–1.0",
 "reason": "string: one line, why this verdict",
 "learn_more_url": "https://ray-ai.com/threats/L0"
}
```

**Auth:** P0 free. P1 BYOK.

**Use case:** Agent calls `rai_judge(content)` before injecting web content / tool results into context. Reads `proceed`; if false, drops the content. Minimal payload, fast.

---

### 3.3 `rai_actiongate_check`

**What:** L4 gate for agent-initiated actions before execution. Returns allow/deny + rule that fired. Deterministic, no LLM call.

**Maps to:** `evaluateMcp()` in `packages/core/action-gate-mcp.ts` (MCP adapter) or `evaluate()` for fs-git/shell.

**Input schema:**
```json
{
 "action_kind": "mcp-tool-call | shell | fs-git | http",
 "tool_name": "string: for mcp-tool-call",
 "arguments": "object: tool arguments as JSON",
 "server_name": "string: downstream MCP server identity",
 "policy": {
 "allowed_tools": ["string"],
 "blocked_tools": ["string"],
 "fail_closed": true
 }
}
```

**Output schema:**
```json
{
 "decision": "allow | deny",
 "rule": "string: stable rule id",
 "reason": "string: human-readable",
 "action_kind": "mcp-tool-call",
 "tool_name": "string"
}
```

**Auth:** Free. No LLM call. Stateless.

**Use case:** Developer puts `rai_actiongate_check` before every tool call in their agent loop. Any tool not on the allowlist is hard-blocked before execution. Works even if P0/P1 missed the injection.

---

### Not MCP tools (deliberate)

- **`rai_threat_explain`**: folded into `rai_scan`/`rai_judge` output (`explanation` + `learn_more_url`). A separate explain tool needs server-side scan storage (statefulness) and the model rarely calls it. The education-to-signup goal is met by the inline `learn_more_url` deep-link.
- **`/health`**: plain HTTP endpoint for uptime monitoring, NOT a model-facing MCP tool. Every exposed tool's schema is injected into every conversation's context; health is infra noise there. `GET /health → {status, version, p0, p1, actiongate}`.

**Tool-list discipline:** 3 model-facing tools on 2 axes: inbound content (`rai_scan`, `rai_judge`) and outbound action (`rai_actiongate_check`). Fewer, sharper tools beat more fuzzy ones for both adoption and per-conversation token cost.

---

## 4. Auth Model

| Tool | Free (no key) | P1 key (BYOK) | Pro token |
|---|---|---|---|
| `rai_scan` (P0) | Yes |, |, |
| `rai_scan` (P1) | No | Yes (caller's Anthropic key) | Yes |
| `rai_judge` (P0) | Yes |, |, |
| `rai_judge` (P1) | No | Yes | Yes |
| `rai_actiongate_check` | Yes |, |, |
| `/health` (HTTP) | Yes |, |, |

**BYOK flow:** caller passes `X-Rai-Claude-Key: sk-ant-...` header. Server uses this key only for the P1 inference call. Never stored. Logged as key-hash only.

**Why BYOK first:** zero marginal cost to RAI for P1 scans. Scales to any usage volume. Enterprise Pro token is the upgrade path once we have billing.

---

## 5. Analytics Hook

Every `rai_scan`, `rai_judge`, and `rai_actiongate_check` call is logged to the existing `ingest-server.ts` pipeline:

```
POST /ingest/scan-event → ScanLogEntry → scan-log → dream-phase aggregation
```

Telemetry fields captured per call (no content stored, hashed only):
- `timestamp`
- `scan_id`
- `tier` (p0/p1)
- `channel` (api: for MCP connector calls)
- `verdict`
- `confidence`
- `recommended_action`
- `threat_layers[]` (layer labels only, no matched text)
- `host_environment`: `mcp-connector`
- `key_hash` (SHA-256 of API key, for per-user cohort)

This is the **analytics dashboard** layer. Aggregate view = "X scan events this week, Y blocked, Z threats by layer." That table is the enterprise pitch artifact.

**Privacy:** No content stored. No origin_url stored (hash only). GDPR-safe by construction.

---

## 6. Deployment

**Phase 1 (spike):** Node.js HTTP server on NanoClaw VPS (Hetzner). Single endpoint, no auth middleware, P0 only. One day to ship.

```
Host: rai.nanoclaw.com (or rai.ray-ai.com)
Transport: HTTP+SSE (MCP streamable transport)
Port: 3848 (adjacent to ingest-server 3847)
```

**Phase 2 (sprint):** Move to Netlify Edge Functions or separate Hetzner VPS for isolation. Add auth middleware. P1 BYOK enabled.

**MCP server registration for Claude Code user:**
```json
{
 "mcpServers": {
 "rai": {
 "type": "url",
 "url": "https://rai.ray-ai.com/mcp"
 }
 }
}
```

Or via Claude Code settings: `Add MCP server → URL → https://rai.ray-ai.com/mcp`

---

## 7. Distribution Path

| Surface | How | Timeline |
|---|---|---|
| Claude Code settings | URL entry, user-added | Day 1 (once server live) |
| Anthropic MCP Marketplace | Submit listing, approval ~1 week | Week 2 |
| Claude.ai connector marketplace | Same listing, different surface | Week 2–3 |
| README + Claude Code docs | Blog post + example config | Week 1 |
| GitHub repo (public) | Open connector code, not core scans | OL-406 dependency |

**Zero-CAC path:** Anthropic surfaces the MCP marketplace inside Claude Code settings. A security-aware developer adds RAI, uses it once on a real injection attempt, hits the dashboard → upgrade path.

---

## 8. Build Estimate

### Option A: 1-day spike (P0 connector only)

Scope:
- HTTP server with MCP streamable HTTP transport
- `rai_scan` (P0 only) + `rai_judge` (P0 only) + `rai_actiongate_check` + `/health` HTTP endpoint
- No auth, no telemetry
- Ships to Hetzner, testable same day

Value: proves the MCP registration flow + distribution hypothesis. Can be shown to a first customer.

### Option B: 1-week sprint (full connector)

Scope:
- All 3 MCP tools at full tier
- BYOK P1 auth
- Telemetry pipeline (ingest-server extension)
- Deployment config (Netlify or dedicated VPS)
- Marketplace listing draft

Value: shippable GTM artifact. Analytics dashboard starts populating from Day 1 of public launch.

**Recommendation: do Option A first.** The spike proves the MCP transport works and generates a URL Tim can paste into a conversation to demo. If it works in 4 hours, extend to Option B in the same sprint.

---

## 9. Open Questions (pre-build)

| # | Question | Default if not answered |
|---|---|---|
| Q1 | Domain: `rai.ray-ai.com` vs `mcp.rai.dev` vs NanoClaw subdomain? | NanoClaw subdomain for spike |
| Q2 | Transport: SSE-only or streamable HTTP? | Streamable HTTP (Claude Code MCP connector default) |
| Q3 | Rate limit for free P0 tier? | 100 req/day per IP, no token required |
| Q4 | `rai_actiongate_check`: accept inline policy or only named policies? | Inline for v0 |
| Q5 | Dashboard: existing app or new? | Existing ingest-server scan-log + dream-phase table |

---

## 10. Dependencies

| Dep | Status |
|---|---|
| `packages/core` rayScan P0 | Live, 78/78 tests |
| `packages/core` scanP1 | Live |
| `packages/core` evaluateMcp | Live |
| `packages/core` ingest-server | Live (port 3847) |
| MCP streamable HTTP transport | npm `@modelcontextprotocol/sdk` server |
| Hetzner VPS (NanoClaw) | Live |
| Public domain for MCP URL | OL-273 (entity-ray.md) dependency |

No new dependencies beyond MCP SDK. All scan logic already ships in `packages/core`.