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
 "explanation": "One sentence. Max 80 chars.",
 "tier_used": "p0 | p1",
 "latency_ms": 42
}
```

**Auth:** P0 = no key required. P1 = requires `RAI_CLAUDE_KEY` header (BYOK) or Pro subscription token.

---

### 3.2 `rai_actiongate_check`

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

### 3.3 `rai_threat_explain`

**What:** Given a scan_id or raw verdict object, return a 2-sentence plain-English explanation of what was detected and why it matters. Education surface: drives "what is this?" moments to dashboard signups.

**Maps to:** P1 explanation field + threat layer schema in `rai-context.md`

**Input schema:**
```json
{
 "scan_id": "string: reference a prior rai_scan result",
 "threat_layer": "L-2 | L-1 | L0 | L1 | L2 | L3 | L4",
 "signal": "string: optional raw signal text"
}
```

**Output schema:**
```json
{
 "explanation": "string, 2 sentences, plain English",
 "threat_layer": "L0",
 "severity": "high",
 "recommended_next": "string: one action the developer should take"
}
```

**Auth:** Free (P0-tier content). P1-quality explanation requires key.

---

### 3.4 `rai_health`

**What:** Liveness + version check. Used by Claude Code to verify the server is reachable.

**Input:** None

**Output:**
```json
{
 "status": "ok",
 "version": "0.1.0",
 "p0": "ready",
 "p1": "ready | no-key",
 "actiongate": "ready"
}
```

**Auth:** None.

---

## 4. Auth Model

| Tool | Free (no key) | P1 key (BYOK) | Pro token |
|---|---|---|---|
| `rai_health` | Yes |, |, |
| `rai_scan` (P0) | Yes |, |, |
| `rai_scan` (P1) | No | Yes (caller's Anthropic key) | Yes |
| `rai_actiongate_check` | Yes |, |, |
| `rai_threat_explain` (P0 qual.) | Yes |, |, |
| `rai_threat_explain` (P1 qual.) | No | Yes | Yes |

**BYOK flow:** caller passes `X-Rai-Claude-Key: sk-ant-...` header. Server uses this key only for the P1 inference call. Never stored. Logged as key-hash only.

**Why BYOK first:** zero marginal cost to RAI for P1 scans. Scales to any usage volume. Enterprise Pro token is the upgrade path once we have billing.

---

## 5. Analytics Hook

Every `rai_scan` and `rai_actiongate_check` call is logged to the existing `ingest-server.ts` pipeline:

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
- HTTP server with MCP JSON-RPC over SSE transport
- `rai_health` + `rai_scan` (P0 only) + `rai_actiongate_check`
- No auth, no telemetry
- Ships to Hetzner, testable same day

Value: proves the MCP registration flow + distribution hypothesis. Can be shown to a first customer.

### Option B: 1-week sprint (full connector)

Scope:
- All 4 tools
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