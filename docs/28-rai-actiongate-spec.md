# RAI ActionGate: Agent Action Firewall
_Created: 2026-04-08_
_Status: Spec draft_
_Trigger: NanoClaw write-gate pattern (OL-022) reviewed in RAI session 2026-04-08_
_Dependency: P0 live, P1 live, NanoClaw 5-layer Write Gate live (proven in production)_

---

## Why ActionGate Exists

RAI today is a **content-side** firewall. P0/P1/P2 all scan what an LLM reads (inbound) or says (outbound). They do not gate what an agent is allowed to **do** with that output.

The fastest-growing class of AI incidents in 2026 is not "the model said something wrong." It is "the agent did something it should never have been allowed to do" — `rm -rf` in the wrong directory, `git push --force` to main, file writes outside scope, shell calls, MCP tool invocations against the wrong endpoint.

NanoClaw's Write Gate (OL-022, shipped 2026-03-21, in production 7+ months) is the proof point. A 5-layer deterministic policy stopped every attempted out-of-scope write from agents in `whatsapp_main` group, including ones that originated from successfully injected prompts that P0/P1 *did not catch in time*. Content scanning is necessary but not sufficient.

**Core insight:** even a fully trusted LLM output must still pass an action policy. Trust is not authorization.

---

## What ActionGate Solves

| Gap | RAI today | ActionGate |
|---|---|---|
| Tool-call enforcement | None | Deterministic allowlist per surface (fs / git / shell / http / MCP) |
| Fail-closed default | P0 warn-only outside critical | All actions blocked unless explicitly allowed |
| Action provenance | Not tracked | Every action tagged with originating scan_id + agent identity |
| Scope creep | Trust-based | Allowlist-based, expand by config not code |
| Post-hoc audit | Scan log only | Action log with full pre/post diff for reversibility |

---

## Architecture

ActionGate is a **policy engine + enforcement hooks**, not a scanner. It runs after the LLM has produced an output and before the host environment executes the resulting action.

```
LLM output (tool call or shell command)
  |
  v
[ActionGate]
  ├── 1. Resolve action target (path, URL, command)
  ├── 2. Identify source group (whatsapp_main, browser, cli, mcp_xyz)
  ├── 3. Apply policy chain (fail-closed, first deny wins)
  │     - Path traversal check
  │     - Extension allowlist
  │     - Depth/scope check
  │     - Subdir / endpoint allowlist
  │     - Basename / verb blocklist
  │     - Hidden / dotfile guard
  │     - Resolved-path containment
  │     - Size / payload limit
  │     - Source group permission
  │     - Sanitization (commit msgs, shell args)
  ├── 4. Verdict: allow | deny | sanitize-and-allow
  └── 5. Audit log (scan_id, agent, action, verdict, diff)
```

### Surface adapters

ActionGate is one core engine, many surface adapters. Each adapter binds the engine to a host environment.

| Adapter | Host | Action types | Status |
|---|---|---|---|
| `fs-git` | NanoClaw write-back | git add/commit/push, file write | **Live** (proven, 5-layer) |
| `shell` | Claude Code, Cursor, Aider | exec, spawn | Spec |
| `mcp` | Any MCP server | tool invocation | Spec |
| `http` | Browser extension agentic mode, API clients | fetch, mutation verbs | Spec |
| `browser-dom` | RAI extension (OL-074) | form submit, click, navigate | Future |

### Policy file format

Plain YAML, version-pinned, hot-reloadable. Same shape across adapters.

```yaml
version: 1
adapter: fs-git
defaults:
  fail_closed: true
  max_size_kb: 50
groups:
  whatsapp_main:
    allowed_subdirs: [proposals, pending-decisions, spikes]
    allowed_extensions: [.md]
    blocked_basenames: [00-WAKE.md, 00-README.md, REGISTRY.md]
    max_depth: 1
    sanitize: [commit_message]
  browser:
    allowed_subdirs: []
    allowed_extensions: []
    fail_closed: true   # explicit no-op, browser cannot write
```

**Expand by appending to YAML, never by code change.** Same principle as NanoClaw Write Gate today.

---

## Threat Layer Mapping

ActionGate adds a new layer to the canonical schema:

| Layer | Label | Coverage |
|---|---|---|
| L-2 | Infrastructure / supply chain | P0 + P1 |
| L-1 | Model poisoning / drift | P0 + P1 |
| L0 | Prompt injection | P0 + P1 |
| L1 | Misinformation | P1 |
| L2 | Cascade risk | P2 |
| L3 | Systemic harm | P2 |
| **L4** | **Agent action / unauthorized side-effect** | **ActionGate (new)** |

L4 is the only layer that protects the **environment** rather than the **conversation**. It composes with all others: a P2-verified clean message can still produce an L4-blocked action, and an L0-flagged message can still produce an L4-allowed action (e.g. an injection attempt that asks for an action the policy already permits).

---

## Vs P2

Orthogonal. They compose.

| | P2 | ActionGate |
|---|---|---|
| Question | "Is this output trustworthy?" | "Is this action permitted?" |
| Mode | Probabilistic, multi-agent consensus | Deterministic, policy-driven |
| Cost | 4 LLM calls per run | Zero LLM calls, microseconds |
| Failure mode | False positive = annoying | False positive = blocked work, fail-closed |
| When it runs | On flagged claims | On every action attempt |

P2 says "trust this." ActionGate says "even if trusted, this is in scope."

---

## Commercial Mapping

| RAI Tier | ActionGate Coverage |
|---|---|
| Free | None |
| Pro | `fs-git` + `shell` adapters, default policies |
| Premium | All adapters + custom policies + audit log |
| Enterprise | All adapters + multi-tenant policies + SIEM export |

**Positioning:** "Your AI firewall doesn't just decide what your model reads. It decides what your model is allowed to do." Sells naturally to anyone running Claude Code, Cursor, MCP servers, or browser agents — i.e. the entire 2026 agentic developer stack.

This is the second commercial tier differentiator after P2. P2 = trust verdicts (Premium). ActionGate = action policy (Pro+).

---

## Reuse from NanoClaw

The `fs-git` adapter exists today on the VPS as the NanoClaw Write Gate. Concrete path:

1. Lift current write-gate code from NanoClaw repo into `packages/core/src/action-gate/`
2. Genericize: extract policy from hardcoded constants into YAML loader
3. Wrap as `ActionGate.evaluate(action, context) -> Verdict`
4. Re-bind NanoClaw to the new module (no behavior change)
5. Ship `@rai/action-gate` as the first published surface
6. Build `shell` and `mcp` adapters from the same engine

Effort: ~1 day for steps 1-4 (refactor + tests). Net new for steps 5-6.

---

## Integration Points

| Host | Hook | Notes |
|---|---|---|
| Claude Code | `PreToolUse` hook in `~/.claude/settings.json` | Already supports synchronous deny via exit code. Direct fit. |
| Cursor / Aider | Shell wrapper around exec | Less clean, requires PATH shim |
| MCP servers | Proxy MCP server that gates downstream calls | Most work, highest leverage |
| Browser extension | Background script intercept on agentic mode | Pairs with OL-074 |
| NanoClaw | Already wired (Write Gate) | Refactor only |

---

## Implementation Plan

| Step | What | Effort | Depends on |
|---|---|---|---|
| 1 | Lift NanoClaw write-gate into `packages/core/src/action-gate/` | 2h | Nothing |
| 2 | YAML policy loader + schema | 2h | Step 1 |
| 3 | `ActionGate.evaluate()` API + unit tests | 2h | Step 2 |
| 4 | Re-bind NanoClaw to new module, regression test | 1h | Step 3 |
| 5 | `shell` adapter + Claude Code PreToolUse hook integration | 3h | Step 3 |
| 6 | `mcp` adapter (proxy server) | 1d | Step 3 |
| 7 | Audit log with scan_id correlation | 2h | Step 3 |
| 8 | Documentation + landing page section | 2h | Steps 1-7 |

Total: ~3 focused days for Pro tier coverage (`fs-git` + `shell`). MCP adapter is a separate sprint.

---

## Open Questions

- Should ActionGate share the SQLite scan history store with P2, or maintain its own action log?
- Policy distribution: bundled defaults vs user-managed YAML vs remote-managed (enterprise)?
- How does ActionGate behave under agent retries — does a denied action increment a counter that triggers a Sentinel cascade flag?
- Browser DOM adapter: feasible at all under MV3, or out of scope until MV4?

---

## Why This Matters Now

Three converging signals:

1. **2026 agentic dev stack is real.** Claude Code, Cursor, MCP, Aider, Lovable agents — all running unguarded tool calls on developer machines. Every horror story is an L4 incident.
2. **NanoClaw Write Gate proves the pattern works.** 7 months in production, zero breaches, expand-by-config not by code. Productionizing is refactoring, not invention.
3. **No competitor occupies this space.** Prompt firewalls exist (Lakera, Protect AI, Rebuff). Action firewalls do not, outside enterprise SIEM bolt-ons that require infra teams to deploy. Consumer/dev tier is empty.

RAI's brand is "ambient firewall for AI." ActionGate is the missing column.
