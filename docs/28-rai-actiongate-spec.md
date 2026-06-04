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

## Capability Separation (Foundational Primitive)

_Source: pipelock-import (github.com/luckyPipewrench/pipelock, Apache 2.0). Architecture pattern, not a code copy. Cross-ref: OL-327._

ActionGate's framing above is **detection-side**: scan the action, apply policy, allow or deny. That is necessary but it shares content-scanning's weakness, it assumes the deciding layer is reachable and uncorrupted. A prompt-injected agent that can reach the policy engine's own controls can try to talk its way past them.

The stronger primitive is **structural**: separate capability so that the component holding secrets cannot reach the network, and the component holding the network cannot read secrets. Even a fully compromised agent then has nothing to exfiltrate to and no control surface to subvert. This is prevention by construction, not prevention by inspection. Detection becomes the second line, not the only line.

### Zone model

Two zones, one mandatory crossing point. All traffic between them crosses the scan boundary; there is no side channel.

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  PRIVILEGED ZONE            │         │  FIREWALL ZONE               │
│  (the agent)                │         │  (ActionGate / proxy)        │
│                             │  IPC    │                              │
│  • holds API keys,          │ ──────► │  • holds network access      │
│    credentials, source      │ fetch / │  • holds NO agent secrets    │
│  • NO direct network access │ CONNECT │  • runs the full scanner +   │
│                             │ / ws /  │    policy pipeline           │
│  • network-isolated:        │ MCP     │  • the only path to the      │
│    cannot dial out itself   │ ◄────── │    internet                  │
└─────────────────────────────┘         └──────────────┬───────────────┘
                                                        │ scanned, policy-gated
                                                        ▼
                                                   INTERNET
```

**Invariant:** secrets and network are never co-located. The agent can hold the crown jewels because it physically cannot reach an attacker-controlled endpoint. The firewall can reach the whole internet because it has no jewels to steal and no agent-authority to abuse.

**Why this beats detection-only:** if the agent is prompt-injected into "exfiltrate the API key to evil.example," the injected instruction lands in a process with no network egress. The only egress is through the firewall zone, which scans every byte and enforces policy. The attacker has to defeat the scanner *and* the policy on a request the agent cannot even originate on its own. Compromising the agent's reasoning no longer compromises the controls.

### Scanner floor invariant

When both a behavioral policy (allow this destination) and the scanner (block this payload) have an opinion, **the scanner block always wins over a policy allow.** A contract or allowlist can never widen what the security floor forbids; it can only narrow within it. This keeps the policy layer from becoming an escalation path.

### How this reframes the L4 layer

| | Detection framing (prior) | Capability-separation framing |
|---|---|---|
| Question | "Is this action permitted?" | "Can the compromised component even reach a target?" |
| Failure assumption | Agent output may be malicious | Agent **process** may be fully owned |
| Primary defense | Policy decision at the gate | Structural isolation; gate is second line |
| Blast radius of agent compromise | Whatever the policy misses | Nothing, secrets cannot leave the privileged zone, network requests cannot skip the scan boundary |

ActionGate's policy engine (below) is the firewall-zone decision logic. Capability separation is the deployment topology that makes that decision logic the *only* path, not just *a* path. The surface adapters (`shell`, `mcp`, `http`) each enforce the crossing point for their transport.

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
| `native-messaging-host` | OS (browser NativeMessagingHosts dirs) | manifest write/modify/remove (vendor covert capability expansion) | **Phase A+B live 2026-04-22** (runner + tests + notify hook + launchd; Linux/Windows pending) |
| `router-audit` | Hybrid-inference router (AI PC OS / on-device classifier) | task routed local↔cloud, sensitivity classification, consent state at the routing boundary | Spec 2026-06-04 (OL-370) |

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

---

## Surface Adapter: `native-messaging-host` (OL-140 Option 2, spec 2026-04-22)

_Covers Vendor Covert Capability Expansion (VCCE) -- the failure class where a trusted vendor writes an IPC manifest to the OS at install time, expanding the attack surface below the model output layer and invisible to prompt/output guards. Anchor case: Anthropic Claude Desktop Native Messaging manifests, documented in 19-rai-context.md._

### Why it fits here, not elsewhere

VCCE sits strictly below RAI P0/P1 (content) and below P2 (consensus on output). The harmful state is established **before any conversation begins** -- a JSON file is written into an OS-known directory, and the browser honours it on next launch. Content scanning is blind to this by construction. The right layer is ActionGate, because:

1. The event is an **action** (file write by a vendor installer or autoupdater), not a conversation message.
2. The enforcement target is the **environment**, not the conversation.
3. The policy model is identical to `fs-git`: allowlist on path + filename + content schema, fail-closed on unknown vendors.

It does NOT fit `fs-git` because the origin is a vendor binary, not an agent. It does NOT fit `shell` or `mcp` because there is no tool call to intercept. The manifest write is a plain filesystem event.

### Watched surfaces

| OS | Paths |
|---|---|
| **macOS (Tier 1, v0 live)** | `~/Library/Application Support/{Chromium,Microsoft Edge,Vivaldi,com.operasoftware.Opera,Arc/User Data,BraveSoftware/Brave-Browser,Google/Chrome}/NativeMessagingHosts/` |
| **Linux (Tier 2, spec)** | `~/.config/{google-chrome,chromium,BraveSoftware/Brave-Browser,microsoft-edge,vivaldi,opera}/NativeMessagingHosts/` + `/etc/opt/chrome/native-messaging-hosts/` (system-wide), `/usr/lib/mozilla/native-messaging-hosts/` (Firefox, future) |
| **Windows (Tier 2, spec)** | Registry: `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\*`, same under `Microsoft\Edge`, `BraveSoftware\Brave-Browser`, `Chromium`, `Vivaldi`. File pointed-to from registry value `(Default)`. HKLM mirror for system-wide. |

v0 covers Tier 1 only (OL-140 Option 1). Option 2 adds Linux + Windows and the policy layer.

### Action shape

```typescript
interface NativeMessagingHostAction {
  adapter: 'native-messaging-host';
  event: 'created' | 'modified' | 'removed' | 'baseline';
  os: 'macos' | 'linux' | 'windows';
  browser: 'chrome' | 'chromium' | 'edge' | 'brave' | 'vivaldi' | 'opera' | 'arc' | string;
  path: string;                // absolute path to manifest file, or registry key on Windows
  manifest: {
    vendor: string;            // `name` field
    description?: string;
    binary_path: string;       // `path` field (target executable)
    host_type: 'stdio' | 'pipe';
    allowed_origins: string[]; // chrome-extension://<id>/ entries
  };
  sha256: string;
  sha256_previous?: string;    // when event != 'baseline'
  allowed_origins_diff?: {
    added: string[];
    removed: string[];
  };
}
```

### Policy model (YAML)

```yaml
version: 1
adapter: native-messaging-host
defaults:
  fail_closed: false   # v0: observe-only. v1 flips to prompt-on-unknown.
  notify: warn
  audit: true
vendors:
  # Known / accepted bridges (user-approved historical state).
  # On `baseline` event with a vendor in this list, verdict = allow silently.
  # On `modified` event, still re-check allowed_origins_diff.
  com.dropbox.nmh:
    allowed_binary_paths: ['/Applications/Dropbox.app/**/dropbox_nmh*']
    allowed_extension_ids: []   # Dropbox manifest has none; enforce empty
    verdict_on_clean: allow
  com.google.drive.nativeproxy:
    allowed_binary_paths: ['/Applications/Google Drive.app/**']
    allowed_extension_ids: ['apdfllckaahabafndbhieahigkjlhalf']  # Drive extension
    verdict_on_clean: allow
  # Vendor-bundled AI bridges: prompt user explicitly, do not silently allow.
  com.anthropic.claude_browser_extension:
    allowed_binary_paths: ['/Applications/Claude.app/**']
    allowed_extension_ids:
      - dihbgbndebgnbjfmelmegjepbnkhlgni   # reserved (404 on CWS 2026-04-22)
      - fcoeoabgfenejglbffodgkkbkcdhcgfn   # public Beta, 6M users
      - dngcpimnedloihjnnfngkgjoidhnaolf   # unlisted / 401-gated
    verdict_on_clean: warn                  # always surface to user
    verdict_on_new_extension_id: block      # new ID outside list = VCCE event
  # OpenAI, Google, Perplexity, local LLM stacks to be added as observed.
unknown_vendor:
  verdict: warn
  reason: "Unknown vendor installed a Native Messaging bridge. Review before use."
  require_user_confirmation: true
policy_rules:
  - id: deny-known-ai-vendor-silent-extension-change
    when:
      vendor_class: ai_vendor
      event: modified
      allowed_origins_diff.added: ['*']
    verdict: block
    reason: "AI vendor added a new extension ID to an existing native-messaging bridge without user action."
  - id: deny-binary-outside-app-bundle
    when:
      binary_path_not_matching: ['/Applications/**', '/usr/local/bin/**', '/opt/**']
    verdict: block
    reason: "Bridge binary lives outside a standard application directory."
```

Vendor classifications (`ai_vendor`, etc.) come from a bundled list, distributed and updated the same way as RAI P0 patterns. Opt-in user-managed YAML overrides the bundled list.

### Verdicts available to this adapter

| Verdict | Semantics at this layer | Realistic enforcement |
|---|---|---|
| `allow` | Silently accept, log to audit | Always achievable (observation only) |
| `warn` | Accept, surface to user via notification channel | Via WhatsApp push (OL-021 pattern), Slack, Telegram, or local notification |
| `sanitize-and-allow` | Quarantine the write by moving the manifest to `~/.rai/vcce-quarantine/` and replacing it with a stub that denies the bridge | Achievable on macOS + Linux (filesystem write); on Windows means registry key swap. Reversible. |
| `block` | Prevent the bridge from functioning | Stronger than `sanitize-and-allow` only if combined with re-write loop guard. Without kernel-level policy (SIP profile, MDM), installers that run on every app launch will recreate the file. RAI must watch + re-quarantine. |

**Design decision:** v0.5 ships `allow + warn` only. `sanitize-and-allow` (quarantine + stub) is v1.0. True `block` without kernel-level policy is inherently racy; document it honestly instead of faking it.

### Migration path from v0 watcher

v0 (`~/no5-scripts/rai-vcce-watch.sh`, launchd `com.rai.vcce-watch`) is already the event producer. The Option 2 work is consumer-side:

1. **Phase A -- JSONL bridge (1h):** ActionGate engine gains a `native-messaging-host` adapter that tails `~/.rai/vcce-watch.jsonl`, normalises each event into the `NativeMessagingHostAction` shape, and runs the policy engine. No change to v0 watcher.
2. **Phase B -- Notification channel (2h):** `warn` verdicts flow to NanoClaw via HTTP POST to a new `/rai/actiongate/notify` endpoint, which pushes to WhatsApp/Telegram. Reuse OL-021 pattern.
3. **Phase C -- Unified audit log (2h):** ActionGate emits to `~/.rai/audit/rai-actiongate.jsonl` using the canonical ActionGate verdict schema. vcce-watch.jsonl remains the source-of-truth file-event log. Audit log is read layer for dashboard (OL-099).
4. **Phase D -- Linux adapter (1d):** inotify-based replacement for fswatch + new path set. Same JSONL shape, same downstream wiring.
5. **Phase E -- Windows adapter (1d):** registry watcher (`RegNotifyChangeKeyValue`) on the Chrome/Edge/Brave keys. Emits into same JSONL. Binary path resolution follows the registry `(Default)` value.
6. **Phase F -- Quarantine mode (1d):** `sanitize-and-allow` implementation. Move manifest to `~/.rai/vcce-quarantine/<browser>/<vendor>.json`, write stub with empty `allowed_origins`. Reversible via `rai vcce release <vendor>`.
7. **Phase G -- Policy distribution (TBD):** bundled vendor list shipped with ActionGate release, user YAML overrides in `~/.rai/actiongate-policy.d/`.

Total Phase A-C: 5 hours for v0.5 (read + normalise + notify + unified audit). Phase D-G follows.

### Open questions (Option 2)

1. **Kernel-level enforcement worth the scope?** `block` semantics are racy at user-space. MDM profile + SIP protection delivers true prevent-write, but those deploy only on managed machines. Position RAI as "observe + warn + quarantine" consumer-tier, and leave true `block` to an enterprise tier that ships with an MDM config companion.
2. **Firefox coverage?** Firefox uses the same NativeMessagingHosts pattern with a different path (`/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS). Identical adapter with one more path list entry, trivial to add once Chromium Tier 1 is shipped.
3. **Vendor classification updates.** Bundled list vs live fetch vs hybrid. Lean hybrid -- ship a static list, check for updates via signed JSON on release cadence. Never auto-update policy behaviour without user approval.
4. **UX for the prompt.** "Anthropic just installed a browser bridge into 7 browsers. Allow, deny, or quarantine for review?" is the right message, but needs testing for non-technical users (the RAI ICP). Real copy drafting is a separate exercise, not spec-level.
5. **Composition with ActionGate scan_id correlation.** VCCE events have no `scan_id` -- they happen outside any LLM conversation. Audit log needs a synthetic identifier (`vcce-<sha256-of-path>-<ts>`) so downstream dashboards can correlate across surfaces. Same shape as ActionGate's normal scan_id for uniformity.

### Pitch deck alignment

Surface Adapter `native-messaging-host` is the concrete payoff of Pitch Deck Beat 4 ("The right layer to fix it"). It is the answer to "what does RAI actually do against the Anthropic case?", the watcher logs the manifest write, the adapter classifies the vendor, the policy prompts or quarantines, the audit log feeds the dashboard. Demo-able end-to-end from a fresh Claude Desktop install.

---

## Surface Adapter: `router-audit` (OL-370, spec 2026-06-04)

_Covers the hybrid-inference routing threat class: an on-device or vendor classifier decides, task by task and invisibly, what stays local and what is sent to the cloud. The user never sees the decision, never consented to the classifier, and gets no log. Anchor case: Computex 2026-06 convergence, NVIDIA (desk agent silicon), Apple (on-device sensitive inference), Microsoft (AI PC OS), Perplexity (mid-task local/cloud router). Source-of-truth narrative + deck copy: `19-rai-context.md` "hybrid-inference router audit" section (mob:2026-06-04)._

### Why it fits here, not elsewhere

The router decision is an action: it moves user data across a trust boundary. ActionGate already gates verbs that move data (`fs-git`, `http`, `native-messaging-host`); the routing boundary is the same class of event one layer lower, the verb is "send this half of the task to the cloud." RAI's structural claim (Constitution Rule 4) is that it audits this decision **without being the entity that profits from it**, the inverse of a vendor router that classifies and routes and bills. This is the cleanest Rule 4 validation to date: RAI sits on the user's side of the router, the only layer that does.

### Watched surface

The routing boundary itself: every task or sub-task the host classifier evaluates for local-vs-cloud dispatch. v0 is observe-only (read the routing decision + emit the tag); it does not intercept the route. Enforcement (`escalate`/`block`) requires host cooperation or an OS hook and is honestly documented as racy until that exists (same posture as `native-messaging-host` true-`block`).

### Action shape

```typescript
interface RouterAuditAction {
  adapter: 'router-audit';
  routed_to: 'local' | 'cloud';
  classified_as: 'sensitive' | 'complex' | string;  // host classifier label, verbatim
  consent_timestamp: string | null;                 // ISO8601, null = no user consent captured
  policy_ref: string | null;                        // vendor policy/rule id that drove the route
  contains_pii?: boolean;                            // RAI-side detection, independent of host label
  task_digest: string;                               // sha256 of the routed payload (no content stored)
  ts: string;                                        // ISO8601 of the routing event
}
```

Schema reuses the OL-315 context-provenance tag near-verbatim; the two compose (a clean provenance tag can still ride a task that the router sends to cloud without consent).

### Policy model (YAML)

```yaml
version: 1
adapter: router-audit
defaults:
  fail_closed: false   # v0: observe-only, emit tag + warn
  notify: warn
  audit: true
policy_rules:
  - id: escalate-uncosented-pii-to-cloud
    when:
      routed_to: cloud
      consent_timestamp: null
      contains_pii: true
    verdict: escalate
    reason: "PII routed to cloud with no captured consent. The classifier decided for you."
  - id: warn-cloud-route-no-consent
    when:
      routed_to: cloud
      consent_timestamp: null
    verdict: warn
    reason: "Task left this machine without an explicit consent record."
  - id: allow-local
    when:
      routed_to: local
    verdict: allow
```

**Enforcement rule (canonical):** `routed_to: cloud AND consent_timestamp: null AND classified_as involves PII → ESCALATE`.

### Verdicts available to this adapter

| Verdict | Semantics at this layer | Realistic enforcement |
|---|---|---|
| `allow` | Local route, or cloud route with valid consent. Log to audit. | Always achievable (observation) |
| `warn` | Surface the crossing to the user: what was sent, how it was classified, that nobody asked. | Via existing notify channels (WhatsApp/Slack/local) |
| `escalate` | Demand explicit user confirmation before the next same-class route; flag the pattern. | Achievable as a prompt loop; does not stop the in-flight route in v0 |
| `block` | Prevent the route. | Racy without host/OS cooperation, documented honestly, not faked (same as `native-messaging-host`) |

**Design decision:** v0 ships `allow + warn + escalate` (signal, never silent verdict, Constitution Rule 1). True `block` is deferred to host-cooperation / OS-hook availability.

### Pitch deck alignment

This adapter is the build-side proof of Pitch Deck v2 Beat 1 ("They told you AI is going local. It's going routed.") and Beat 2 (the Computex four-vendor convergence). POS: "the user's-side observer of the inference routing decision", survives the local-vs-cloud pendulum entirely, because RAI watches the boundary regardless of which way it swings. Deck copy lives in `19-rai-context.md`.

### Cross-ref

OL-370 (this adapter), OL-315 (`context-provenance` gate, schema reuse + composition), OL-265 (`process-spawn` / Confused Deputy, paired pre-flight class), OL-240 (Distributed Sensing Architecture), `19-rai-context.md` "hybrid-inference router audit" section (source-of-truth narrative, enforcement rule, Beat 1+2 deck copy), Constitution Rule 4 (audit-without-profit differentiator).

---

## Pre-Flight Gate: `context-provenance` (OL-315, spec 2026-05-23)

_Covers the Silent Context Injection threat class: identity, presence, or behavioral signals that enter an agent's working context below the user's awareness and below existing security tooling. Anchor case: KIT/KASTEL BFI paper (CCS '25, ScienceDaily 2026-05-22) -- WiFi beamforming feedback information (unencrypted, standard hardware) identifies people with ~100% accuracy, no device required. Paired with the process-spawn adapter (OL-265, Confused Deputy class) as the two ActionGate pre-flight extensions that protect the agent's pre-action state._

### Why it fits here, not elsewhere

Silent Context Injection sits strictly below P0/P1 (content) and below P2 (output consensus). The harmful state is established **before any agent action begins** -- a context item like `user_is_authenticated`, `room_occupant: tim`, or `device_proximity: trusted` lands in the agent's working context via an ambient sensor or an inferred signal, with no prompt, no consent, no audit trail. Content scanning is blind to this by construction.

The right layer is ActionGate, because:

1. The relevant event is the **assembly** of action-shaping context, not a conversation message.
2. The enforcement target is the **agent's pre-action state**, not its output or its tool call.
3. The policy model is allowlist + verification on `(source, method, consent)` tuples, identical in shape to `fs-git` allowlists on `(path, extension, group)`.

Difference from the surface adapters above: this gate runs *before* a tool call exists. It does not gate verbs, it gates the inputs that decide which verbs the agent will reach for. Same pre-flight class as the OL-265 process-spawn adapter -- both protect what the agent *starts from*, not what it *does*.

### Provenance tag schema

Every identity, presence, or behavioral context item entering an agent's working context must carry a provenance tag:

```json
{
  "source": "wifi_bfi | ble_proximity | user_login | session_cookie | camera_inference | mic_inference | mdm_signal | ...",
  "method": "passive_inference | active_auth | explicit_assertion",
  "consent_timestamp": "ISO8601 | null",
  "policy_ref": "rai-policy-v1:section-3 | null"
}
```

Field semantics:
- `source`: where the context value originated. Sensor type, auth surface, or upstream declared origin.
- `method`: how the value was obtained. `passive_inference` = derived without an explicit user act; `active_auth` = obtained through an authentication step the user performed; `explicit_assertion` = user stated it.
- `consent_timestamp`: ISO8601 of the moment the user consented to *this source* feeding context. `null` = no record of consent.
- `policy_ref`: pointer into RAI policy YAML that authorizes this `(source, method)` pair. `null` = unauthorized by current policy.

Untagged context items are treated as `consent_timestamp: null` and `policy_ref: null` by construction. Fail-closed by default.

### Enforcement rule (BLOCK / ESCALATE)

Pre-flight verdict on each context item:

| Condition | Verdict |
|---|---|
| `consent_timestamp != null` AND `policy_ref != null` | `allow` |
| `consent_timestamp == null` AND `method == passive_inference` | **`block` or `escalate`** |
| `consent_timestamp == null` AND `method` in (`active_auth`, `explicit_assertion`) | `warn` (record + surface) |
| `policy_ref == null` (unknown source) | `escalate` (require user confirmation) |
| `source` in deny-list | `block` |

**Canonical hard rule:** if `consent_timestamp: null` AND `method: passive_inference` → BLOCK or ESCALATE.

`block` = drop the context item before the agent sees it. `escalate` = surface to user via notify channel (WhatsApp / Telegram / local notification, OL-021 pattern), require explicit grant before retry. The block / escalate choice is policy-driven: consumer tier defaults to `escalate` (user-in-the-loop), enterprise tier defaults to `block` (fail-closed, SIEM-logged).

### Policy file format (YAML)

```yaml
version: 1
adapter: context-provenance
defaults:
  fail_closed: true
  unknown_source: escalate
sources:
  user_login:
    allowed_methods: [active_auth]
    require_consent: true
  session_cookie:
    allowed_methods: [active_auth]
    require_consent: true
  wifi_bfi:
    allowed_methods: []            # passive_inference only, structurally non-consensual
    verdict: block
  ble_proximity:
    allowed_methods: [explicit_assertion]
    verdict_on_passive: block
  camera_inference:
    allowed_methods: []
    verdict: block
  mic_inference:
    allowed_methods: []
    verdict: block
  mdm_signal:
    allowed_methods: [active_auth]
    require_consent: true
deny_list:
  - wifi_bfi
  - camera_inference
  - mic_inference
```

Expand by appending to YAML, never by code change. Same principle as `fs-git` and `native-messaging-host`.

### Pairing with the process-spawn adapter (OL-265)

Both gates are ActionGate pre-flight extensions. They protect the **agent's pre-action state**, not its post-action side-effects. They compose:

| Pre-flight gate | Watches | Source |
|---|---|---|
| `context-provenance` (OL-315, this section) | What context items entered the agent's working state, and whether they were consented to | Sensor / auth / ambient signal layer |
| `process-spawn` (OL-265) | Whether the browser/shell process the agent runs in was spawned by a human session or by another agent (Confused Deputy class, VentureBeat 2026-05-13) | Process lineage / agent-spawn audit |

A context item from a trusted source can still flow into an agent-spawned browser process; a process-spawn lineage can still be clean for an agent operating on un-consented context. Both gates must pass for the action chain to proceed. Failure on either is a pre-flight stop -- the surface adapters (`fs-git`, `shell`, `mcp`, `http`, `browser-dom`, `native-messaging-host`) never get the chance to evaluate.

### Verdicts available to this gate

| Verdict | Semantics |
|---|---|
| `allow` | Context item passes pre-flight, agent receives it |
| `warn` | Pass, but record + surface to user (consented source, unknown policy_ref) |
| `escalate` | Hold the agent turn, prompt user to grant or deny the source explicitly |
| `block` | Drop the context item silently; agent never sees it |

`block` is achievable at this layer because the gate sits in the context-assembly path before the agent reads. Unlike OS-level `block` in `native-messaging-host`, there is no race window.

### Pitch deck alignment

This gate is the concrete payoff of Beat 1 ("The Unowned Gap") in Pitch Deck v2. It is the answer to "what does RAI actually do against Silent Context Injection?" -- the diagram's Column 1 callout (`RAI ActionGate: Context Provenance Enforcement. Source declared. Consent verified. Policy checked. Before the agent acts.`) maps 1:1 to this gate's schema + enforcement rule. Demo-able from any agent runtime that accepts the provenance tag at context-write time.

### Cross-ref

OL-315 (Silent Context Injection threat class, this gate's origin), OL-265 (ActionGate process-spawn / Confused Deputy, paired pre-flight gate), OL-240 (Distributed Sensing Architecture), `19-rai-context.md` Beat 1 diagram spec + Context Provenance Tag Schema section (source-of-truth for the schema), KIT/KASTEL BFI paper (CCS '25, ScienceDaily 2026-05-22, anchor evidence).

