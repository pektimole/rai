# RAI Clinical: Audit Trail & Decision Provenance Spec
_Created: 2026-05-28_
_Status: Spec draft_
_Audience: Christina Nimal, Joy Akisanya (clinical decision provenance)_
_Source: pipelock-import (github.com/luckyPipewrench/pipelock, Apache 2.0). Schema + signing recipe adapted from Pipelock EvidenceReceipt v2 / in-toto agent-action-receipt v0.1. NOT a code copy._
_Cross-ref: OL-327 (extraction), 28-rai-actiongate-spec.md (L4 action layer that emits receipts), OL-300 (L1 hot-reload, contract-hash binding)_

---

## Why this exists

RAI Clinical makes or gates decisions that touch patient-adjacent workflows. A clinical audience does not accept "the system decided X." They require **portable, third-party-verifiable proof** of:

- what action was attempted,
- what RAI decided and why,
- which policy version governed the decision,
- who authorized it and which agent acted,
- that the record was not altered after the fact.

The Pipelock primitive that fits exactly: a **signed evidence receipt**. One signed record per mediated decision, content-addressed, verifiable offline by anyone holding the public key, with no dependency on RAI's own runtime being available or trusted at verification time. That last property is the clinical requirement: the clinician (or anyone they choose to share the trail with) must be able to verify it with a 50-line script and a public key, not with access to our servers.

**Design rule (inherited from Pipelock block-reason header spec):** once a clinical consumer reads a field, the vocabulary is locked. Renaming a field or a reason code is a breaking change requiring a version bump. Lock the schema before any production consumer commits to it.

---

## Receipt model

One receipt per gated clinical decision. JSON object, signed with Ed25519, canonicalized with RFC 8785 JCS before signing so the signature is over a deterministic byte sequence independent of key ordering or whitespace.

### Required fields

| Field | Type | Description |
|---|---|---|
| `record_type` | const `clinical_evidence_receipt_v1` | Envelope discriminator. Verifiers reject unknown values fail-closed. |
| `receipt_version` | const `1` | Schema major version. Increment for breaking changes. |
| `event_id` | string (UUIDv7) | Globally unique per decision. Time-ordered (RFC 9562). |
| `decided_at` | string (RFC 3339) | UTC, millisecond precision, `Z` suffix. Pattern enforces `Z` (numeric offsets rejected) and exactly 3 fractional digits. |
| `action_type` | enum | `read`, `write`, `delegate`, `authorize`, `derive`, `unclassified`. (Clinical subset of Pipelock's vocabulary; `spend` / `actuate` / `commit` reserved, not emitted by v1.) |
| `target` | string | What the action acted on (record ID surface, tool name, endpoint). Free-form by surface. MUST NOT carry patient identifiers in cleartext. |
| `verdict` | enum | `allow`, `block`, `warn`, `ask`, `redirect`. |
| `principal` | string | Identity authorizing the action (clinician identity, OAuth subject, local operator). |
| `actor` | string | Identity of the agent / workload that took the action. |
| `policy` | object | `{ name?, uri?, digest: { sha256 } }`. The policy bundle that governed the decision. `digest.sha256` binds the decision to an exact, immutable policy version. |
| `signature` | object | See "Signing" below. |

### Conditional / optional fields

| Field | Type | Rule |
|---|---|---|
| `verdict_reason` | string | **Required** when verdict is `block`, `warn`, `ask`, `redirect`. **MUST be absent** when verdict is `allow`. Canonical reason code (see vocabulary). |
| `delegation_chain` | string[] | Ordered authority chain principal → actor. Absent/empty for direct authorization. |
| `parent_event_id` | string (UUIDv7) | Causal predecessor decision within the same session. |
| `session_id` | string | Opaque session handle. Not a stable cross-session identity. |
| `findings` | object[] | Detector hits that drove the verdict. Each: `{ layer, rule, severity, position? }`. `position` is a structural pointer (e.g. `body.note[2]`), **never raw matched bytes**. |
| `reversibility` | enum | `full`, `compensatable`, `irreversible`, `unknown`. Clinically load-bearing: an irreversible action demands a stronger trail. |
| `data_classes_in` / `data_classes_out` | string[] | DLP class labels carried in/out. Labels only, never values. |
| `notes` | string | Human context. MUST NOT contain PHI, secrets, or raw bytes. |

### Hash-chain fields (tamper-evidence)

To make the trail tamper-**evident** (not just tamper-resistant), receipts chain:

| Field | Type | Description |
|---|---|---|
| `chain_seq` | integer | Monotonic per-session sequence number. |
| `chain_prev_hash` | string | `sha256:<hex>` of the prior receipt's canonical signed bytes. First receipt in a chain uses a fixed genesis value. |

A gap or mismatch in the chain is detectable offline. An attacker who deletes or reorders a receipt breaks the chain at the deletion point.

---

## Signing

Ed25519 (RFC 8032) PureEdDSA over the JCS-canonicalized receipt. The recipe is the load-bearing part: it must be reproducible by an independent implementation, byte-for-byte.

**Signature object:**

```json
{
 "signer_key_id": "<stable key identifier>",
 "key_purpose": "clinical-receipt-signing",
 "algorithm": "ed25519",
 "signature": "ed25519:<hex>"
}
```

**Signable preimage (the exact bytes that get signed):**

1. Take the full receipt object.
2. Set `signature` to the zeroed shape: `{ "signer_key_id": <id>, "key_purpose": <purpose>, "algorithm": "ed25519", "signature": "" }`. The signature value is empty; the surrounding metadata stays.
3. JSON-serialize, then JCS-canonicalize (RFC 8785): sort object keys lexicographically, minimal number/string encoding, no insignificant whitespace.
4. The resulting byte sequence is the preimage. Sign it with Ed25519. The signature string is `"ed25519:" + hex(sig)`.

**Verification:**

1. Parse the receipt. Extract `signature`.
2. Reconstruct the preimage: zero the signature value (keep `signer_key_id` / `key_purpose` / `algorithm`), JCS-canonicalize.
3. Resolve the public key by `signer_key_id` against the trusted key roster. Reject if the key's purpose does not match `key_purpose` (purpose binding prevents a receipt-signing key from being misused as, e.g., a policy-activation key).
4. `ed25519.verify(pubkey, preimage, sig)`. Reject on failure.
5. If chained: verify `chain_prev_hash` equals `sha256:` + sha256 of the prior receipt's canonical signed bytes.

**Key fingerprint:** `"sha256:" + sha256(raw 32-byte public key)`, hex-encoded. This is the stable, portable key identity an external auditor pins.

**Key purposes** (verifiers reject signatures from the wrong purpose):

- `clinical-receipt-signing`: hot key, signs every receipt, regular rotation (≤90d).
- `clinical-policy-activation`: cold/operator key, signs the active policy manifest that `policy.digest.sha256` points at. Separate purpose so a leaked hot key cannot forge policy provenance.

---

## Python reference verifier

Dependencies: `jcs` (RFC 8785 canonicalization), `cryptography` (Ed25519). This is the artifact the clinical audience runs to verify a trail without trusting RAI infrastructure.

```python
import hashlib
import json
from jcs import canonicalize
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

SIG_PREFIX = "ed25519:"

Def key_fingerprint(raw_pubkey: bytes) -> str:
 return "sha256:" + hashlib.sha256(raw_pubkey).hexdigest()

Def _preimage(receipt: dict) -> bytes:
 # Reconstruct the exact bytes that were signed: zero the signature
 # value but keep the surrounding metadata, then JCS-canonicalize.
 Clone = json.loads(json.dumps(receipt))
 sig_obj = clone["signature"]
 clone["signature"] = {
 "signer_key_id": sig_obj["signer_key_id"],
 "key_purpose": sig_obj["key_purpose"],
 "algorithm": sig_obj["algorithm"],
 "signature": "",
 }
 return canonicalize(clone)

Def verify_receipt(receipt: dict, roster: dict, expected_purpose: str) -> bool:
 """roster maps signer_key_id -> {'pubkey': raw32bytes, 'purpose': str}."""
 sig_obj = receipt["signature"]
 if sig_obj.get("algorithm") != "ed25519":
 raise ValueError("unsupported algorithm")
 if not sig_obj.get("signature", "").startswith(SIG_PREFIX):
 raise ValueError("malformed signature")

 key_id = sig_obj["signer_key_id"]
 entry = roster.get(key_id)
 if entry is None:
 raise ValueError(f"unknown signer_key_id {key_id}")
 # Purpose binding: fail-closed if the key was issued for a different role.
 If entry["purpose"] != expected_purpose or sig_obj["key_purpose"] != expected_purpose:
 raise ValueError("key purpose mismatch")

 sig = bytes.fromhex(sig_obj["signature"][len(SIG_PREFIX):])
 preimage = _preimage(receipt)
 pub = Ed25519PublicKey.from_public_bytes(entry["pubkey"])
 try:
 pub.verify(sig, preimage)
 except InvalidSignature:
 return False
 return True

Def verify_chain(receipts: list[dict], roster: dict) -> bool:
 """Verify each receipt's signature AND the hash chain linking them."""
 GENESIS = "sha256:" + "0" * 64
 prev_hash = GENESIS
 for r in sorted(receipts, key=lambda x: x["chain_seq"]):
 if not verify_receipt(r, roster, "clinical-receipt-signing"):
 return False
 if r["chain_prev_hash"] != prev_hash:
 return False # gap, reorder, or deletion detected
 prev_hash = "sha256:" + hashlib.sha256(_preimage(r)).hexdigest()
 return True
```

A failed verification is fail-closed: any exception or `False` means the receipt is not trustworthy. An empty receipt list verifies vacuously and MUST be treated by the caller as "no trail," not "valid trail."

---

## Clinical audit requirement mapping

| Clinical requirement | Receipt mechanism |
|---|---|
| "Prove what was decided and when" | `verdict` + `verdict_reason` + `decided_at` (ms-precision UTC) |
| "Prove which policy applied" | `policy.digest.sha256` binds to an immutable policy version |
| "Prove who authorized it" | `principal` + `delegation_chain` |
| "Prove the agent identity" | `actor` |
| "Prove the record was not altered" | Ed25519 signature over JCS canonical bytes |
| "Prove nothing was deleted" | `chain_seq` + `chain_prev_hash` (gap detection) |
| "Verify without trusting the vendor" | Offline verifier + pinned public-key fingerprint |
| "Classify irreversible actions" | `reversibility` enum |
| "Never leak PHI into the audit log" | `position` / `notes` / `target` carry pointers and labels, never values |

---

## Worked example

A clinical agent attempts to write to an out-of-scope record; RAI blocks it.

```json
{
 "record_type": "clinical_evidence_receipt_v1",
 "receipt_version": 1,
 "event_id": "01934e1c-cd60-7abc-823a-d6f5e6f7a8b9",
 "decided_at": "2026-05-28T14:09:33.512Z",
 "action_type": "write",
 "target": "ehr:record/scope-out-of-band",
 "verdict": "block",
 "verdict_reason": "contract_default_deny",
 "principal": "oauth:c.nimal@clinic.example",
 "actor": "rai-agent:clinical-intake",
 "policy": {
 "name": "rai-clinical-policy",
 "digest": { "sha256": "3f29a1b5c7d8e9f01234567890abcdef9c46a3f8b1c2d4e5f60718293a4b5c6d" }
 },
 "findings": [
 { "layer": "contract", "rule": "ehr_write_scope", "severity": "critical", "position": "body.target" }
 ],
 "reversibility": "irreversible",
 "data_classes_in": ["phi-ref"],
 "chain_seq": 47,
 "chain_prev_hash": "sha256:9c46a3f8b1c2d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef",
 "signature": {
 "signer_key_id": "clinical-receipt-2026q2",
 "key_purpose": "clinical-receipt-signing",
 "algorithm": "ed25519",
 "signature": "ed25519:<hex>"
 }
}
```

---

## Findings vocabulary

`findings[].layer` aligns with the RAI threat-layer schema and the ActionGate layers:

`dlp`, `injection`, `ssrf`, `tool_policy`, `contract`, `chain`, `redaction`.

`findings[].severity`: `critical`, `high`, `medium`, `low`, `info`.

`verdict_reason` draws from the canonical block-reason vocabulary shared with ActionGate / OL-300 (see 28-rai-actiongate-spec.md and the OL-300 block-reason header section). Clinical-relevant codes: `dlp_match`, `contract_default_deny`, `contract_enforce_default`, `tool_policy_deny`, `authority_mismatch`, `redaction_failure`.

---

## Open questions

- Portable export format: do we wrap receipts in DSSE / in-toto for clinical consumers who already ingest attestation bundles, or ship the bare signed JSON? (Pipelock offers both; clinical audience likely wants bare JSON + a one-page verify guide first.)
- Key roster distribution: how the clinician (or anyone they share the trail with) obtains the public-key fingerprint to verify against, published fingerprint list vs signed roster document.
- PHI boundary review with Christina before any field that could carry a record reference goes live in `target`.
- Retention: hash-chained receipts are append-only; where do they live (Notion DB at P3 per 19-rai-context Q2, or a dedicated immutable store)?
- Cross-ref OL-300: the `policy.digest.sha256` here is the same contract-hash primitive the L1 hot-reload path will emit. One canonical hash, two consumers (live enforcement + clinical audit).