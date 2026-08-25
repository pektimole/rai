# RAI: Exit-Diligence Aggregate Attestation Layer Spec

_Created: 2026-08-25_
_Status: Spec draft, not built. Build trigger: exit conversations going live (Equity Story v1 Act 4 sequencing), not immediate._
_Audience: future strategic-acquirer diligence team; internal build reference._
_Cross-ref: OL-531 (this spec), OL-370 (aggregation-point economics), 19-rai-context.md Equity Story v1 card + /challenge addendum obj #3 (2026-08-18), Constitution Rule 4 ("RAI knows nothing about the user"), 32-rai-clinical-audit-spec.md (receipt/signing pattern reused by reference, not duplicated)._

---

## Why this exists

Equity Story v1 Act 4 prices the exit on **verified-user count x ledger-depth distribution x neutrality-intact**. Constitution Rule 4 means RAI structurally cannot produce a conventional data room to evidence any of the three: there is no per-user table to hand an acquirer's DD team, by design. Run against `/challenge`, this was ranked "real, buildable" (obj #3, 19-rai-context.md addendum, 2026-08-18): an unbankable exit metric with no proof layer is not diligenceable, but the metric itself is provable in aggregate without breaking the no-visibility constraint.

**Scope, precisely:** a proof layer that attests three aggregate properties to a diligence audience, without exposing per-user data:
1. Verified-user count (a number).
2. Ledger-depth distribution (a histogram, not per-user rows).
3. Neutrality / no-profiling invariant (a property of the data schema and pipeline, not a statistic).

**Not in scope / explicitly distinct:** this is not the OL-271/438/L1c declared-vs-actual scope-attestation family. Those prove intent-matches-execution on a single completed action (did the agent do only what it said it would do). This spec proves a property of an aggregate dataset under a standing no-visibility constraint (can a claim about the whole be true-and-provable when nobody, including RAI, is allowed to read the parts). Different primitive, different threat model, do not conflate in future edits to either family.

---

## Design principle (inherited from Constitution Rule 4)

Any mechanism here must hold even against RAI itself: the proof cannot depend on an acquirer trusting RAI's internal honesty at the moment of diligence, only on the standing discipline of the pipeline that produced the underlying commitments over time. This is the same design instinct as 32-'s hash-chain (tamper-**evident**, not just tamper-resistant): a snapshot manufactured only at exit time is worthless, the evidentiary value comes from continuous, pre-committed record-keeping the seller cannot retrofit.

---

## Candidate approaches

| Approach | What it proves | Trust model | Build cost | Maturity |
|---|---|---|---|---|
| **A. ZK aggregate proof** (zk-SNARK/STARK over a committed ledger) | Exact aggregate predicates (count ≥ N, histogram shape, schema-level invariants like "no field X exists in any record") with cryptographic soundness | Trustless verification of the proof itself; still requires the underlying commitments to have been made honestly over time, not retrofitted (see Open Question 1) | High: custom circuit per predicate, ongoing engineering to keep proofs synced with schema changes | Tooling exists (Groth16/PLONK/Halo2, aggregate-proof precedent in identity/DeFi systems), but this exact application is novel engineering, not off-the-shelf |
| **B. Differential-privacy-bounded published stats** | Statistical honesty of published numbers within a known noise (epsilon) bound, signed and chained | Weaker, verifier trusts RAI's internal pipeline produced the true pre-noise values; DP bound blocks re-identification, not fabrication | Low-medium, reuses 32-'s Ed25519/JCS signing + hash-chain infra almost directly, new receipt schema only | High, well-trodden (Apple/Google DP telemetry precedent) |
| **C. Third-party audited attestation** | Human/institutional credibility an acquirer already knows how to price (audit-opinion-style letter) | Trust shifts to the auditor's reputation + a documented "auditor sees aggregates, structurally cannot see users" access model | Low technical build, non-trivial operational/legal build (auditor selection, NDA, access harness), recurring cost at exit time | Fully mature as a practice, zero cryptographic risk, but weakest "constitutionally provable" story for a claim RAI otherwise sells as trustless |

None of the three alone closes the loop. **A** is the only one of the three that can prove the neutrality/no-profiling invariant itself (a property of code and schema, not a number), **B** and **C** can only vouch for numbers, never prove an absence.

---

## Recommended phasing

1. **Now → build trigger:** no build. This is P1, not urgent; the honest status is spec-only until exit conversations are live, per Act 4 sequencing.
2. **When exit conversations open:** ship **B** first. Cheapest, reuses existing 32- signing infra, gives an evidentiary floor (signed, chained, DP-bounded user-count and ledger-depth numbers) fast.
3. **At live diligence:** wrap **B**'s numbers in **C**: a third-party auditor attests the pipeline that emits the DP receipts is faithful. This is the human-credibility layer a diligence team expects regardless of what cryptography sits underneath.
4. **Priority build if only one gets funded:** **A**, specifically for the neutrality/no-profiling invariant. That claim is the one piece of Act 4 that DP stats and human audit structurally cannot prove (you cannot audit-opinion your way to "this schema has never contained a profiling field"): it needs a circuit over the storage schema, not a bigger sample size or a signature.

---

## Attestation statement schema (draft)

Reuses the 32- receipt/signing pattern by reference (Ed25519 over JCS-canonicalized JSON, `chain_seq`/`chain_prev_hash` for tamper-evidence, `signer_key_id` + `key_purpose` binding) rather than redefining it. New fields specific to this receipt type:

| Field | Type | Description |
|---|---|---|
| `record_type` | string | `"aggregate-attestation"` |
| `receipt_version` | string | Schema version |
| `attested_at` | string | ISO 8601 timestamp |
| `period_start` / `period_end` | string | Aggregation window this statement covers |
| `method` | string | `"dp-bounded"` \| `"zk-proof"` \| `"third-party-audit"` |
| `metrics.verified_user_count` | integer or DP-noised integer | Per `method` |
| `metrics.ledger_depth_distribution` | object (histogram buckets) | Never per-user rows |
| `metrics.neutrality_invariant` | object `{claim, method, proof_ref}` | `proof_ref` = circuit id / verification key hash (method A) or auditor letter hash (method C); omitted for method B, which cannot make this claim |
| `dp_epsilon` | number, optional | Present only if `method = "dp-bounded"` |
| `auditor` | object, optional | Present only if `method = "third-party-audit"`: name, engagement scope, letter hash |
| `signature` | object | Per 32- signature object shape, `key_purpose: "exit-attestation-signing"` (new purpose, do not reuse `clinical-receipt-signing`) |

---

## Open questions

1. **Commitment timing.** Must aggregate commitments be logged continuously (periodic append to a timestamped/public-anchored chain) to prevent a "clean" snapshot manufactured only at exit? Almost certainly yes, given the design principle above: needs a concrete cadence (daily/weekly) decided at build time, not left implicit.
2. **Verification party.** Does the acquirer's own team run the verifier locally (per 32-'s "verify without trusting RAI infrastructure" posture), or does RAI host a verification service? Local verification is the stronger claim; hosted is faster to ship.
3. **Historical vs. Point-in-time neutrality.** Does the no-profiling invariant need proving only over the live schema at exit, or over the full history (i.e., proving profiling data was *never* present, not just isn't now)? This materially changes the ZK circuit design and should be settled before any method-A build starts.
4. **Legal acceptance.** Will a real acquirer's diligence process accept a cryptographic/DP proof as a data-room substitute, or does it remain a technical-credibility layer that still needs method C wrapping it regardless of what's built underneath? Unknown until tested against an actual counterparty; do not over-invest in A before this is sanity-checked with someone who runs M&A diligence.
5. **Phasing re-check at build time.** If the runway to exit conversations turns out longer than assumed at spec time, does that change the recommendation to skip the B/C stopgaps and go straight to A? Re-evaluate phasing against actual timeline when the build trigger fires, don't execute this spec's phasing on autopilot.

---

## Status

Spec, not built. No code, no circuit, no receipt schema implementation exists yet. This file is the scoping artifact requested by OL-531; it commits to a recommended phasing and a draft schema, not a shipped primitive.