# RAI P2: Multi-Agent Consensus Architecture
_Created: 2026-04-05_
_Status: Spec draft_
_Trigger: WhatsApp conversation 2026-04-05, Tim + Nano re: April Fools blind spot_
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

- Should agent chains use WebSearch for live verification, or only analyze provided content?
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

