# RAI L1 Hot-Reload: Rule Injection & Policy-Authoring Spec
_Created: 2026-05-28_
_Status: Spec draft (OL-300 deliverable)_
_Trigger: OL-300 (hot-reload rule injection, Dark Reading 2026-05-21: policy must ship on the same clock as dev AI ships code)_
_Source of policy-authoring primitive: pipelock-import (github.com/luckyPipewrench/pipelock learn-and-lock v2.4, Apache 2.0), OL-327. Architecture pattern, not a code copy._
_Cross-ref: OL-300, OL-239 (RAI Network Architecture), 28-rai-actiongate-spec.md (L4 enforcement), 32-rai-clinical-audit-spec.md (receipts share the contract-hash primitive)_

---

## Problem (OL-300)

The L1 regex layer has no hot-reload path. A new threat pattern requires a release cycle. Security policy must go from "idea" to "live enforcement" on the same clock that dev AI ships code. Acceptance: a new L1 rule active in <60s from authoring, zero downtime, with versioning + rollback.

Hot-reload alone is the *mechanism*. The harder half is **where the rules come from** without a human hand-writing regexes for every agent. The learn-and-lock primitive supplies that: observe an agent's real traffic, compile a behavioral contract from what it actually did, and promote that contract as live policy. This is the policy-generation layer the VCCE watcher lacks.

---

## Part A: Policy-authoring primitive (learn-and-lock)

A **behavioral contract** is a per-agent, typed, signed policy envelope distilled from observed traffic. Generic rules ("blocklist these domains") cannot know that *this* agent never POSTs to `repos.example.com`. The contract is that missing per-agent layer. It is **opt-in and default-off**: a new agent runs uncontracted until you compile, ratify, and promote one.

### Four-phase pipeline

| Phase | What it does |
|---|---|
| 1: observe | Run in capture mode. Traffic accumulates in a hash-chained JSONL flight recorder, one log per session. |
| 2: compile | Read the recorder log, infer rule shapes, emit a **signed candidate contract** + a human-readable review report. |
| 3: shadow | Replay captured traffic through the candidate **without enforcing**. Emits "would-have-blocked" deltas so you see the contract's effect before committing. |
| 4: activate | Two-phase: operator **ratifies** per rule, then **promotes** via a signed active-manifest swap. Once promoted, the contract enforces live and emits a decision receipt per request. |

Supporting operator verbs: `review`, `diff` (compare two shadow runs), `split` (demote a collapsed normalization segment back to literals), `pin` (lock a literal so recompile cannot collapse it), `rollback --to <manifest-hash>`, `forget --rule-id --reason` (remove one rule before ratification).

### Contract shape

- **Kind:** `behavioral_contract`, schema version 1.
- **Rule kinds:** `http_destination` (URL/host/method/path), `http_action`, `mcp_tool_call`.
- **Lifecycle states:** `proposed` → `capture_only` → `enforce` → `expired` (or `demoted`). The runtime only enforces rules in `enforce`.
- **Confidence model:** every inferred rule carries a Wilson lower bound at 95% with **conditional-on-opportunity** denominators (a rule is "stable" because requests *where the opportunity existed* mostly fit it, not because all traffic fit it). Hard floors gate promotion: `min_sessions`, `min_events`, `min_windows`. A rule cannot be `stable` unless it clears Wilson AND the floors.
- **Path normalization:** per-bucket frequency-weighted entropy, bucketed by `(host, method, parent-prefix, segment-position)`, never global. Collapses `/users/123` → `/users/<id>` but never merges across high-risk siblings (`/admin/*` stays separate from `/users/*`). A reserved-segment blocklist (`admin`, `auth`, `oauth`, `token`, `billing`, `vault`) prevents sensitive nouns from being collapsed. Tail coverage is explicit: when the `_other` bucket exceeds 5% of a host's events, promotion is **blocked** unless the operator annotates `accept_tail: true`. No silent tail.

### Activation safety (the part that makes hot-reload safe)

- **Signed active manifest.** Storage is content-addressed: immutable per-manifest blobs, write-once contract bodies, signed monotonic `active.json`. No symlinks, no plain pointers. Every swap is signed; every accepted manifest is immutable.
- **Two-phase promote (atomic).** Emit signed `promote_intent` → swap via compare-and-swap on `prior_manifest_hash` with a monotonic generation counter → validate → emit signed `promote_committed`. Failure at any step keeps the previous manifest active.
- **fsnotify reload.** Runtime watches the manifest store, 100ms debounce, 2s max-debounce cap. **Fail-closed on initial load** (an unreadable manifest blocks rather than silently falling back to no-policy). A crash between intent and commit is recovered by walking the accepted-history chain on next reload, so the runtime never strands on a stale manifest. → This is the <60s, zero-downtime acceptance criterion, satisfied by construction.
- **Tombstones.** A signed withdrawal marker makes a contract hash operationally dead: rejected at promotion time, rejected during accepted-load chain walk, and every re-promote attempt emits a high-severity audit event. A tombstoned rule cannot be re-introduced by editing config, replaying a signed envelope, or poisoning `prior_manifest_hash`. → This is OL-300's rollback requirement, hardened.
- **Scanner floor wins.** A contract `allow` can never override a scanner `block`. Policy narrows within the security floor; it can never widen past it.

### Adapting to RAI L1

| Pipelock concept | RAI L1 mapping |
|---|---|
| Behavioral contract | The hot-reloadable L1 rule bundle, per agent/surface |
| `compile` from flight recorder | Rule generation from observed traffic (VCCE watcher's missing layer) |
| `shadow` replay | Dry-run a candidate rule against recent traffic before it goes live |
| Signed active-manifest swap | The hot-reload mechanism, atomic + versioned + rollback-able |
| fsnotify, fail-closed | <60s activation, zero downtime, fail-closed on bad rule |
| Tombstone | Hard rule retraction that cannot be silently re-added |
| Confidence floors | Gate on auto-generated rules so a 5-event rule never auto-enforces |

---

## Part B: Block-reason header (machine-readable enforcement output)

When L1 blocks, the response must say *why* in a machine-readable form an agent can act on (back off, switch tools, surface the right error) instead of an opaque 403. **Lock the vocabulary before any production consumer reads it**, renaming a code is a breaking change.

### Header set

| Header | Required | Example | Meaning |
|---|---|---|---|
| `RAI-Block-Reason` | yes | `dlp_match` | Machine-readable reason code. |
| `RAI-Block-Reason-Version` | yes | `1` | Schema version; bump on breaking change. |
| `RAI-Block-Reason-Severity` | yes | `critical` | `info` / `warn` / `critical`. |
| `RAI-Block-Reason-Retry` | yes | `none` | `none` (permanent), `transient` (retry w/ backoff), `policy` (retry only after policy change), `retry-with-canonical-path`. |
| `RAI-Block-Reason-Layer` | optional | `dlp` | Scanner pipeline layer label. |
| `RAI-Block-Reason-Receipt` | optional | `0190a3c4-...` | Opaque receipt ID (fixed-length ULID or UUIDv7) to fetch the matching evidence receipt. |

### Reason vocabulary (seed, adapt per RAI layers)

- **Egress:** `scheme_blocked`, `domain_blocklist`, `ssrf_private_ip`, `ssrf_metadata`, `ssrf_dns_rebind`, `path_entropy`, `subdomain_entropy`, `url_length`, `rate_limit`, `data_budget`.
- **Content:** `dlp_match`, `prompt_injection`, `redaction_failure`, `media_policy`.
- **MCP / tool:** `tool_policy_deny`, `tool_chain_blocked`, `tool_poisoning`, `session_binding`.
- **Posture:** `kill_switch_active`, `authority_mismatch`, `escalation_level`, `session_anomaly`, `cross_request_deny`, `redirect_scan_denied`.
- **Contract / learn-and-lock:** `contract_default_deny` (jurisdiction claimed, no allow rule matched), `contract_enforce_default` (host matched, full shape did not), `contract_non_default_port`, `contract_invalid_path` (retry-with-canonical-path), `contract_observed_only` (shadow/capture annotation, **never on a block surface**, receipts/telemetry only).
- **Generic:** `parse_error`, `timeout`, `pattern_unavailable`, `not_enabled`, `bad_request`, `block_reason_overflow`.

### Privacy (hard rules)

Header values are **operational metadata only**. Never in any header value:
- Matched secret content (the code `dlp_match` is fine; the matched substring is not).
- Pattern names that identify the regex (invites probing).
- Agent IDs, session IDs, user-attributable data, internal IPs, private hostnames.

Required values (`Reason`, `Severity`, `Retry`) are validated against fixed allowlists at construction. The receipt slot accepts only a fixed-length ULID or UUIDv7 so attacker-controlled strings cannot reach an agent-visible header. Reject any non-conforming value before it reaches the wire.

### Transport framing

Same schema on every surface; only framing differs. HTTP transports use response headers. WebSocket uses a close-frame JSON payload with the same fields, capped at 123 bytes (RFC 6455), fields drop in order `receipt` → `layer` → `retry` → `severity` → `version`, leaving `block_reason` as the always-present floor. MCP-stdio has no HTTP layer; reasons flow through the JSON-RPC error envelope.

---

## Implementation notes for OL-300

1. **Hot-reload mechanism** = signed active-manifest swap + fsnotify watcher (fail-closed initial load, debounced, chain-walk recovery). This is the literal <60s/zero-downtime/rollback acceptance criterion.
2. **Rule-injection API** (`POST /rules` per OL-300) writes a candidate to the contract store and triggers a promote, rather than mutating live regex in place. Promotion is the only path to enforcement; it is signed and versioned.
3. **Versioning + rollback** = monotonic generation counter + immutable manifest blobs + tombstones. Rollback is `rollback --to <manifest-hash>` against accepted history.
4. **Block output** = the `RAI-Block-Reason` header set above, vocabulary locked at v1.
5. **Receipts** = every contract decision (allow or block) emits an evidence receipt bound to the active manifest hash + contract hash + rule ID + generation + verdict (see 32-rai-clinical-audit-spec.md, the same contract-hash primitive serves both live enforcement and audit).

## Anti-patterns (carry over)

- Ratifying without reviewing the candidate report (promoting rules backed by 5 events).
- Compiling on a trivial workload (a thin capture blocks every novel-but-legitimate request).
- Reusing one contract across agents (the whole point is per-agent; contracts are selector-scoped).
- Auto-enforcing generated rules below the confidence floor.