# RAI P2: Multi-Agent Consensus Architecture
_Created: 2026-04-05_
_Updated: 2026-05-19 (BS Council layer added — OL-281)_
_Status: Spec draft. Threat-axis code-complete (22 tests). Verifiability-axis (BS Council) spec-only, implementation pending._
_Trigger: WhatsApp conversation 2026-04-05, Tim + Nano re: April Fools blind spot. 2026-05-19 update: Shai-Hulud/Turnbull misclassification — OL-281._
_Dependency: P1 live (shipped 2026-03-29), P0 live_

---

## Why P2 Exists

P0 (regex) and P1 (single LLM call) can converge on the same wrong answer. Redundancy within a single reasoning chain is not real redundancy.

**The April Fools case:** Claude Code source leak (real, March 31). Counter-claim "hoax" circulated April 2. Both P0 and P1 accepted the counter-claim because both used the same reasoning chain. Valid intelligence was retracted.

**Core insight (Tim):** "In reality RAI will need to consult multiple agent chains to do the job good and reliable." Single-chain architectures, no matter how many layers, share the same epistemic blind spots.

---

## What P2 Solves

| Gap | P0/P1 state | P2 requirement |
|---|---|---|
| Same-chain convergence | Both layers trust same false signal | Independent verification agents with different priors |
| No temporal context | Each message scanned in isolation | Claim timeline tracking (when did claim first appear vs counter-claim) |
| No source weighting | All inputs treated equally | Source credibility scoring (VentureBeat vs anonymous Twitter) |
| No cross-session memory | prior_scan_ids in schema but unused | Cascade detection across sessions (L2/L3 threat layers) |
| No provenance checking | Accepts claims at face value | Traces claim origin, publication timing, circulation velocity |

---

## Architecture

### Agent Chains (independent, not sequential)

```
Inbound claim (P0/P1 flagged or uncertain)
  |
  ├── Agent A: Provenance Check
  |   "Did this claim come from official channels?"
  |   "When was it first published?"
  |   "How quickly did it circulate relative to the event?"
  |
  ├── Agent B: Cross-Reference Scorer
  |   "Do multiple independent sources confirm/deny independently?"
  |   "Are sources citing each other or independently reporting?"
  |
  ├── Agent C: Temporal Context
  |   "Is timing suspicious? (April 1 proximity, post-market hours, etc.)"
  |   "Does the counter-claim appear suspiciously fast?"
  |
  ├── Agent D: Source Credibility
  |   "What is the track record of this source?"
  |   "Official disclosure channel vs social media vs anonymous?"
  |
  └── Consensus Layer
      Weighted merge of A-D verdicts
      Disagreement = flag for human review
      Agreement = high confidence verdict
```

### Trigger Logic

P2 does NOT run on every message. Trigger conditions:

1. P1 verdict is `flagged` with confidence < 0.70 (uncertain)
2. P1 detects L1 (misinformation) or L2 (cascade) threat layer
3. Claim involves verifiable facts (not opinion, not code)
4. Explicit `/rai-deep` command from Tim

### Cost Model

- P2 fires rarely (estimated 1-3x per week based on P1 flag rate)
- Each P2 run = 4 Haiku calls (~$0.01) or 4 Sonnet calls (~$0.40) depending on claim complexity
- Budget: <$5/month at current message volume
- Commercial (Premium tier): included in subscription, cost absorbed by pricing
- **BS Council adds web_search cost on Agents A+B.** Sonnet + web_search ~$0.05/agent/run. BS Council total ~$0.15-0.25/run vs $0.40 for current 4xSonnet without grounding. Fewer agents (A+B grounded > 4 ungrounded) is cheaper AND more accurate.

---

## BS Council Layer (added 2026-05-19, OL-281)

### Why this section exists

Shai-Hulud/Turnbull misclassification, 2026-05-15: RAI called "high-confidence disinfo" on a real CVE-9.6 event before running a single search. Initial verdict flipped 180° on verify-request. Root cause: existing P2 chains run on **content only**, no web grounding. Same-chain convergence + no external anchor = high-confidence wrong answers when source material is the only input.

The BS Council fix is structural, not a prompt patch:

1. **Two parallel axes** — threat (is content malicious?) and **verifiability** (is the factual claim true per independent sources?). Existing P2 covers the threat axis. BS Council adds the verifiability axis.
2. **Web grounding is mandatory** for verifiability-axis agents A+B. Different query angles, not the same search twice.
3. **Verify-Before-Verdict** — verifiability verdict precedes confidence language. A flagged claim cannot be labelled "high-confidence false" without citation stack. `UNVERIFIED` is the default when grounding is missing or weak; "high-confidence" requires explicit source backing.

### The two axes

| Axis | What it answers | Verdict set | Layer producing it |
|---|---|---|---|
| Threat | Is this content trying to attack, mislead, inject? | confirmed_threat / likely_threat / uncertain / likely_safe / false_positive | Existing P2 (`mergeVerdicts`) |
| Verifiability | Is the factual claim true per independent web sources? | CONFIRMED / CONTESTED / UNVERIFIED / FALSE-ALARM | BS Council (`mergeBSVerdicts`, new) |

`FALSE-ALARM` = "we initially treated this as a threat but verification shows the claim is factually true." This is exactly the Turnbull case. Without this verdict, the threat axis has no way to self-correct against valid intelligence flagged as disinfo.

### Agent role mapping + heterogeneous models

BS Council reuses existing P2 agents with re-scoped roles. **Each agent runs on a different model family** — heterogeneous priors are the whole point. Same-vendor multi-model = same training data + same RLHF = same blind spots (pseudo-redundancy, the original P2 failure mode escalated one level).

| BS Council role | Existing agent | Model family (default) | Query strategy | web_search? |
|---|---|---|---|---|
| **Agent A** — independent corroboration | cross-ref | Anthropic Sonnet (cloud, commercial) | Claim-as-query: "<claim verbatim>" + "verify" + "source" | Required |
| **Agent B** — origin chain | provenance | Open-weight, distinct vendor (Qwen 3 / Llama 3.3 / DeepSeek V3) via Together AI cloud OR Ollama local | Entity-extracted: named entities/CVE-IDs/dates + "first reported" + "official disclosure" | Required |
| **Agent C** — source weighting | credibility | Haiku (Anthropic cloud) — cheap classification | Registry-driven via `SourceCredibility` index | No |
| **Agent D** — timeline verification | temporal | Open-weight local (Ollama Qwen 2.5 / Gemma 3) — small model, structured task | Date-bounded: "<claim entity>" + "<claim date ± 7d>" + "superseded" / "updated" | Optional |

**Three orthogonal axes of diversity** (the whole point):

1. **Query angle** — A asks "is this verifiable?", B asks "where did it originate?". Same claim, different lens.
2. **Model family** — A = Anthropic Sonnet, B = Qwen/Llama/DeepSeek. Different training corpora, different RLHF, different refusal patterns.
3. **Compute substrate** — A = commercial cloud, B = open-weight (cloud OR local). Different censorship layers, different version drift, different vendor incentives.

Pseudo-redundancy failure modes prevented:
- Two Sonnet calls converging on Anthropic's training-data bias.
- Two cloud calls converging on commercial RLHF priors (e.g. both refusing the same controversial topic).
- Two web-search calls converging on the same top-3 SERP results.

### Model routing config

Per-agent model selection is config, not code. `p2-council.json` (new):

```json
{
  "agents": {
    "A": { "provider": "anthropic", "model": "claude-sonnet-4-6", "web_search": true },
    "B": {
      "provider": "together",
      "model": "Qwen/Qwen3-72B-Instruct",
      "web_search": true,
      "fallback_local": { "provider": "ollama", "model": "qwen2.5:32b" }
    },
    "C": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001" },
    "D": { "provider": "ollama", "model": "qwen2.5:14b", "fallback_cloud": { "provider": "together", "model": "Qwen/Qwen2.5-72B-Instruct" } }
  },
  "tier_overrides": {
    "free":    null,
    "pro":     { "B": { "provider": "ollama", "model": "qwen2.5:32b" }, "C": null, "D": { "provider": "ollama" } },
    "premium": "use defaults"
  }
}
```

Tier mapping:
- **Free** — BS Council unavailable (no agent runs; no data leaves device per Free contract).
- **Pro (BYOK)** — Agent A on user's Anthropic key. Agent B/D on local Ollama if available, otherwise BS Council degrades to Agent A + C only with `UNVERIFIED` bias.
- **Premium** — full quartet, managed compute, Together AI for B, local Ollama optional for D.

### Pseudo-code: dispatch

```typescript
async function runBSCouncil(input: P2Input, config: CouncilConfig): Promise<BSCouncilResult> {
  const tasks = ['A', 'B', 'C', 'D'].map(role => {
    const cfg = resolveAgentConfig(role, config, input.tier);
    if (!cfg) return Promise.resolve(noSignal(role));   // tier gating
    return runAgent(role, cfg, input).catch(err => fallback(role, cfg, err, input));
  });
  const breakdown = await Promise.all(tasks);
  return mergeBSVerdicts(input.scan_id, breakdown);
}
```

Failure handling: any single agent failure → partial council with `no_signal` for that role. `mergeBSVerdicts` already handles partial breakdowns by demoting verdict tier (see rule 3: all `no_signal` → `UNVERIFIED`).

### Output schema

```typescript
export type BSCouncilVerdict =
  | 'CONFIRMED'      // independent sources confirm the claim
  | 'CONTESTED'      // sources disagree; claim has support and contradiction
  | 'UNVERIFIED'     // no usable sources; default when grounding fails
  | 'FALSE-ALARM';   // claim was threat-flagged but verifiability says it's true

export interface Citation {
  url: string;
  title: string;
  source_tier: CredibilityTier;
  published_at?: string;
  excerpt: string;          // evidence span, ≤ 280 chars
  supports: 'claim' | 'counter' | 'context';
}

export interface BSCouncilResult {
  scan_id: string;
  axis: 'verifiability';
  verdict: BSCouncilVerdict;
  confidence: number;
  agent_breakdown: {
    A: { verdict: 'supports' | 'contradicts' | 'no_signal'; citations: Citation[]; query: string };
    B: { verdict: 'supports' | 'contradicts' | 'no_signal'; citations: Citation[]; query: string };
    C: { tier: CredibilityTier; weight: number; reasoning: string };
    D: { verdict: 'current' | 'outdated' | 'superseded' | 'no_signal'; reasoning: string };
  };
  citations: Citation[];     // deduped union of A+B citations, ranked by tier × supports-weight
  explanation: string;       // one-line; surfaces in extension popup default state
}
```

### Verdict merge logic (`mergeBSVerdicts`)

Parallel to existing `mergeVerdicts`, separate function. Rules:

1. **Both A and B support, ≥1 each from tier ≥ established** → `CONFIRMED`
2. **A and B disagree (one supports, one contradicts), or A+B contradict** → `CONTESTED`
3. **A and B both return no_signal, OR all citations are tier ≤ social** → `UNVERIFIED`
4. **Verdict is `CONFIRMED` AND P1/P2 threat-axis flagged this as misinfo/disinfo** → emit `FALSE-ALARM` alongside `CONFIRMED` (dual-tag)
5. **Agent D verdict = `outdated` or `superseded`** → demote one tier (CONFIRMED → CONTESTED, CONTESTED → UNVERIFIED)
6. Agent C feeds into citation ranking + final confidence; does not change verdict directly.

Confidence: `(supporting_citation_weight - contradicting_citation_weight) / total_citation_weight`, clamped to [0, 1]. Single low-tier citation must not produce >0.5 confidence.

### Two-Gate Protocol

Gate 1 — **Verify-Before-Verdict** (claim-level)
- Fires before P1/P2 threat verdict is finalized for any claim containing: CVE IDs, named entities + verbs ("X attacked Y", "Z disclosed W"), dated statistics, quoted figures, "breaking" / "just reported" language.
- Gate 1 sequence: claim extraction → BS Council fires → BSCouncilResult merged into final threat verdict.
- Effect: threat-axis verdict cannot be `high_confidence` if verifiability verdict is `UNVERIFIED` or `CONTESTED`. Forced to `uncertain` recommended_action: `human_review`.

Gate 2 — **Action Pre-Flight** (agent-action level)
- Fires before any agent-initiated mutating action (write, send, commit, post) on content that flowed through Gate 1.
- Re-runs verifiability check if more than `STALENESS_THRESHOLD` (default 6h) since Gate 1 verdict.
- Output gates ActionGate (28-rai-actiongate-spec.md): `UNVERIFIED` or `CONTESTED` content blocks the action by default.

Gate 1 is RAI's epistemic firewall. Gate 2 is RAI's action firewall consuming Gate 1's output.

### Trigger conditions (BS Council vs base P2)

Base P2 trigger conditions (existing) still apply. BS Council adds:

5. Content contains a verifiable factual claim (CVE, statistic, named entity action, dated event) — Gate 1 detection
6. Content was previously verdict-stamped within last `STALENESS_THRESHOLD` AND user requests re-verification (`/rai-verify`, "are you sure?", "verify this")
7. Confidence-language rule: any P1/P2 prompt output containing "high-confidence" without citation triggers BS Council retroactively before emit

### Acceptance criteria

The Turnbull-flip test is the canonical regression case:

```
GIVEN  claim "Shai-Hulud Worm: 187 packages, 9.6 CVSS, real"
WHEN   first scan runs (no grounding)
THEN   verdict ≠ "high-confidence false"
       AND BS Council fires (Gate 1 detection: CVE + named worm + statistic)
       AND verdict ∈ {CONFIRMED, CONTESTED, UNVERIFIED}
       AND citations.length > 0 OR verdict = UNVERIFIED

GIVEN  user follow-up "verify this claim"
WHEN   re-scan runs
THEN   verdict consistency: same verdict OR documented escalation
       AND no 180° flip without new evidence
       AND if verdict changes, explanation references the new citations
```

### What this changes structurally

| Layer | Before | After |
|---|---|---|
| Existing 4 P2 agents | Independent threat-axis verifiers | Dual-role: threat axis (existing) + verifiability axis (BS Council) |
| Web grounding | None | Mandatory on A+B for verifiability axis |
| Output | Single threat verdict | Dual verdict (threat axis + verifiability axis, both surfaced) |
| Confidence language | Free-form | "high-confidence" requires citation stack; otherwise auto-downgrade |
| Action gating | ActionGate consults policy only | ActionGate consults policy + BS Council Gate 2 freshness check |

### Implementation order (OL-281 wire-up)

| Step | What | Effort |
|---|---|---|
| 1 | Spec section (this section) — DONE 2026-05-19 | — |
| 2 | `BSCouncilVerdict`, `Citation`, `BSCouncilResult`, `CouncilConfig` types in `p2-agent/src/types.ts` | 20min |
| 3 | New file `p2-agent/src/bs-council.ts` with `mergeBSVerdicts` | 1h |
| 4 | Provider adapters: `p2-agent/src/providers/anthropic.ts`, `together.ts`, `ollama.ts` (shared interface) | 1.5h |
| 5 | `web_search` tool wired into Agent A+B via per-provider tool-spec mapping (Anthropic native, Together via tool-call schema, Ollama via local web_search fn) | 1.5h |
| 6 | Gate 1 detector (claim-has-verifiable-fact regex + entity extraction) | 30min |
| 7 | `p2-council.json` config loader with tier-override resolution | 30min |
| 8 | Tests: Turnbull-flip (canonical), April Fools (existing regression), no-grounding-fallback, model-divergence (A says CONFIRMED + B says CONTRADICTED → CONTESTED) | 1.5h |
| 9 | Two-Gate ActionGate hook (Gate 2 in `packages/core/actiongate/`) | parked behind step 8 |

Total: ~6-7h for steps 2-8. Multi-model adds ~2h vs single-vendor path but is the actual product (epistemic diversity is the value prop). Step 9 deferred until BS Council engine is green.

### Open questions (BS Council-specific)

- Web search provider: Anthropic native `web_search` tool vs Brave/Tavily/Exa? Native preferred — keeps API surface uniform, no extra credentials.
- Per-agent rate limit: web_search caps. Need to know Anthropic's per-key rate before declaring P2 always-on for premium tier.
- Caching: same claim re-scanned within `STALENESS_THRESHOLD` should hit cache. Cache key = SHA256(normalized_claim). Storage: existing scan_history table (add `bs_council_result` JSONB column).
- Local-only mode: BS Council requires web. For RAI Free tier (zero data leaves device), BS Council is unavailable. Pro/Premium only.

---

## Sentinel Integration

P2 provides the foundation for RAI Sentinel (ambient session observer, spec in 19-rai-context.md):

- **P2 = claim-level** verification (single message, multiple agents)
- **Sentinel = session-level** drift detection (multiple messages over time)
- Both require cross-session memory (prior_scan_ids, scan history DB)
- Shared infrastructure: scan history store, temporal context engine

Build order: P2 claim verification first, Sentinel session observer second. P2 is simpler (stateless per-claim), Sentinel requires state management.

---

## Data Requirements

### Scan History Store

P2 needs to query previous scans. Minimum viable:

```
scan_history {
  scan_id: uuid
  timestamp: ISO8601
  channel: string
  verdict: clean | flagged | blocked
  threat_layers: json
  confidence: float
  claim_hash: string (for dedup)
  source_url: string | null
}
```

SQLite on VPS is sufficient. NanoClaw already has SQLite (db.ts).

### Source Credibility Index

Seed list of known sources with credibility tiers:

| Tier | Examples | Weight |
|---|---|---|
| Official | Company blogs, CVE databases, SEC filings | 0.9 |
| Established media | VentureBeat, TechCrunch, Fortune | 0.7 |
| Community | HackerNews, Reddit, dev.to | 0.5 |
| Social | Twitter/X, Telegram groups | 0.3 |
| Anonymous | Pastebin, anonymous forums | 0.1 |

Not a blocklist. Weight feeds into consensus scoring.

---

## Commercial Mapping

| RAI Tier | P2 Coverage |
|---|---|
| Free | None (P0 only) |
| Pro | None (P0 + local P1) |
| Premium | Full P2 multi-agent consensus |
| Enterprise | P2 + custom agent chains + Sentinel |

P2 is the differentiation layer between Pro and Premium. "Your AI firewall doesn't just pattern-match. It thinks."

---

## Implementation Plan

| Step | What | Effort | Depends on |
|---|---|---|---|
| 1 | Scan history table in NanoClaw SQLite | 1h | Nothing |
| 2 | Agent A-D as separate prompt templates | 2h | Step 1 |
| 3 | Consensus merge function | 1h | Step 2 |
| 4 | P2 trigger logic in rai-scan-p1.ts | 1h | Step 3 |
| 5 | `/rai-deep` command wiring | 30min | Step 4 |
| 6 | Source credibility index (seed) | 1h | Nothing |
| 7 | Integration test (replay April Fools case) | 1h | Steps 1-5 |

Total: ~1 day focused work. Not complex, just needs the right trigger conditions and prompt templates.

---

## Open Questions

- ~~Should agent chains use WebSearch for live verification, or only analyze provided content?~~ **Resolved 2026-05-19 (OL-281): Agents A+B mandatory web_search for verifiability axis; threat axis stays content-only.**
- Consensus threshold: majority vote or weighted confidence merge?
- Should P2 results feed back into P1 prompt (learning loop) or stay independent?

---

## claw-code Referenzen fuer P2 Implementierung (2026-04-05)

_Source: ~/eval/claw-code_

| Referenz | P2-Relevanz |
|---|---|
| `mock-anthropic-service` + PARITY.md | Deterministischer Mock-API-Service fuer reproduzierbare P2 Integration Tests. Step 7 ("April Fools Replay") kann direkt auf dieser Infrastruktur aufbauen. 10 existierende Szenarien als Vorlage. |
| `trust_resolver.rs` (TrustPolicy: AutoTrust/RequireApproval/Deny) | Architekturvorlage fuer Source Credibility Index. TrustPolicy-Enum direkt auf Credibility-Tiers (Official/Established/Community/Social/Anonymous) mappbar. |
| `lane_events.rs` | Event-normalisierung fuer Scan-History-Store. Maschinenlesbare Events statt Text-Parsing -- genau was prior_scan_ids + Temporal-Context-Agent braucht. |
| PARITY.md Harness-Skript | `rust/scripts/run_mock_parity_diff.py` als Vorlage fuer automatisierten P2 Regression-Test-Lauf (Claim-Replay gegen historische Verdicts). |

