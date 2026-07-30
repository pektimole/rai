/**
 * contract-ratify.ts — Learn-and-lock phase 4: ratify + promote (OL-461)
 *
 * Phase 4 is the two-step that makes a candidate contract go live
 * (docs/33-rai-l1-hotreload-spec.md Part A, phase 4: activate):
 *
 *   ratify  — an operator flips eligible `proposed` rules → `enforce`, per rule.
 *             Only `stable` rules are eligible (naming a below-floor rule is the
 *             "ratify rules backed by 5 events" anti-pattern and is rejected).
 *             The lifecycle change mutates the contract body, so the contract is
 *             re-signed: a ratified contract has a NEW content id.
 *
 *   promote — the ratified, signed contract is wrapped in a signed
 *             active-contract-manifest and swapped in through a gated, atomic
 *             compare-and-swap (two-phase: signed promote_intent → CAS on
 *             prior_manifest_hash with a monotonic generation → validate →
 *             signed promote_committed). Failure at any step keeps the previous
 *             manifest active (fail-closed).
 *
 * This mirrors the proven L1Registry gated swap (l1-registry.ts) but in a
 * SEPARATE enforcement zone: the contract registry holds only the public key
 * (verify-only, never signs), and it is deliberately distinct from the regex
 * scanner's manifest. Keeping the two zones apart is what makes "scanner floor
 * wins" (docs/33 Part A, Activation safety) true by construction — a contract
 * `allow` lives in a different registry from the scanner's `block` floor and can
 * never touch it. The live per-request gate evaluation and evidence receipts are
 * a later increment (the HTTP/MCP gate adapter); phase 4 delivers the signed,
 * atomic activation the gate will read its enforce-set from.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, phase 4: activate).
 */

import * as crypto from 'crypto';
import { canonicalize, keyFingerprint, type KeyPair } from './l1-manifest.js';
import {
  contractId,
  signContract,
  verifyContract,
  type BehavioralContract,
  type ContractRule,
} from './contract-compile.js';

// ---------------------------------------------------------------------------
// ratify
// ---------------------------------------------------------------------------

export class RatifyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unverified_contract'
      | 'promotion_blocked'
      | 'unknown_rule'
      | 'non_stable_rule'
      | 'no_eligible_rules',
  ) {
    super(message);
    this.name = 'RatifyError';
  }
}

export interface RatifyOptions {
  /** Explicit rule ids to enforce. Every id must exist and be `stable`. When
   *  omitted, every stable rule is ratified. */
  ruleIds?: string[];
}

/**
 * Ratify a signed candidate contract: flip the selected eligible rules'
 * lifecycle `proposed` → `enforce` and re-sign. Fail-closed and conservative:
 *
 *  - the incoming contract must verify against `keys` (never ratify a tampered
 *    or unsigned candidate),
 *  - a `promotion_blocked` contract (no stable rules, or an un-accepted tail)
 *    cannot be ratified,
 *  - only `stable` rules are eligible; naming a below-floor rule throws,
 *  - rules not selected keep their current lifecycle (a `proposed` rule stays
 *    proposed; an already-`enforce` rule stays enforce).
 *
 * Returns a NEW signed contract (the input is not mutated). Ratifying an already
 * -ratified contract with the same selection is idempotent: the body is
 * unchanged, so the re-signed contract has the same content id.
 */
export function ratifyContract(
  contract: BehavioralContract,
  keys: KeyPair,
  opts: RatifyOptions = {},
): BehavioralContract {
  if (!verifyContract(contract, keys.publicKey)) {
    throw new RatifyError('candidate contract does not verify', 'unverified_contract');
  }
  if (contract.promotion_blocked) {
    throw new RatifyError(
      'contract promotion is blocked (no stable rules or un-accepted tail)',
      'promotion_blocked',
    );
  }

  const byId = new Map(contract.rules.map((r) => [r.id, r]));
  const stableIds = new Set(contract.rules.filter((r) => r.confidence.stable).map((r) => r.id));

  let toEnforce: Set<string>;
  if (opts.ruleIds) {
    toEnforce = new Set();
    for (const id of opts.ruleIds) {
      const rule = byId.get(id);
      if (!rule) throw new RatifyError(`no such rule: ${id}`, 'unknown_rule');
      if (!rule.confidence.stable) {
        throw new RatifyError(`rule ${id} is below floor, not eligible to ratify`, 'non_stable_rule');
      }
      toEnforce.add(id);
    }
  } else {
    toEnforce = stableIds;
  }

  if (toEnforce.size === 0) {
    throw new RatifyError('no eligible (stable) rules to ratify', 'no_eligible_rules');
  }

  // Deep-copy rules, flipping only the selected ones. Structured clone keeps the
  // confidence/ports/schemes sub-objects independent of the input.
  const rules: ContractRule[] = contract.rules.map((r) => {
    const copy = structuredClone(r);
    if (toEnforce.has(r.id)) copy.lifecycle = 'enforce';
    return copy;
  });

  // Rebuild the body unsigned (created_at preserves compile provenance; the
  // promotion timestamp lives on the manifest envelope), then re-sign.
  const ratified: BehavioralContract = {
    ...contract,
    rules,
    key_fingerprint: '',
    signature: '',
  };
  return signContract(ratified, keys);
}

/** The rules that would be enforced live, i.e. lifecycle `enforce`. */
export function enforceRulesOf(contract: BehavioralContract): ContractRule[] {
  return contract.rules.filter((r) => r.lifecycle === 'enforce');
}

// ---------------------------------------------------------------------------
// active-contract-manifest (the signed envelope that gets swapped in)
// ---------------------------------------------------------------------------

/**
 * A signed, versioned envelope wrapping one ratified contract as live policy.
 * `generation` is monotonic; `prev_hash` chains to the prior manifest's id (the
 * compare-and-swap target). `contract_id` binds the envelope to the exact
 * contract body — a manifest whose id does not match its contract is rejected.
 */
export interface ContractManifest {
  kind: 'rai_contract_manifest';
  schema_version: 1;
  generation: number;
  prev_hash: string | null; // prior ContractManifest id, or null for the first
  agent: string; // selector scope, carried from the contract
  created_at: string; // promotion time (distinct from contract.created_at)
  key_fingerprint: string;
  contract_id: string; // contractId(contract) — binds envelope to body
  contract: BehavioralContract;
  signature: string; // base64 ed25519 over the canonical envelope, signature ''
}

function manifestPreimage(m: ContractManifest): string {
  return canonicalize({ ...m, signature: '' });
}

/** Content id of a manifest (includes its signature). The chain link + the
 *  compare-and-swap target. */
export function contractManifestId(m: ContractManifest): string {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(m), 'utf-8').digest('hex');
}

/** Build + sign an active-contract-manifest around an already-signed ratified
 *  contract. */
export function signContractManifest(
  contract: BehavioralContract,
  keys: KeyPair,
  generation: number,
  prevHash: string | null,
  createdAt: string,
): ContractManifest {
  const m: ContractManifest = {
    kind: 'rai_contract_manifest',
    schema_version: 1,
    generation,
    prev_hash: prevHash,
    agent: contract.agent,
    created_at: createdAt,
    key_fingerprint: keyFingerprint(keys.publicKey),
    contract_id: contractId(contract),
    contract,
    signature: '',
  };
  const sig = crypto.sign(null, Buffer.from(manifestPreimage(m), 'utf-8'), keys.privateKey);
  m.signature = sig.toString('base64');
  return m;
}

/** Fail-closed signature check on the manifest envelope. */
export function verifyContractManifest(m: ContractManifest, publicKey: crypto.KeyObject): boolean {
  try {
    if (m.kind !== 'rai_contract_manifest' || m.schema_version !== 1) return false;
    if (typeof m.signature !== 'string' || m.signature.length === 0) return false;
    if (m.key_fingerprint !== keyFingerprint(publicKey)) return false;
    const sig = Buffer.from(m.signature, 'base64');
    return crypto.verify(null, Buffer.from(manifestPreimage(m), 'utf-8'), publicKey, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// registry — the enforcement zone (verify-only, atomic gated swap)
// ---------------------------------------------------------------------------

export class ContractPromotionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'bad_signature'
      | 'contract_unbound'
      | 'contract_unverified'
      | 'non_stable_enforce'
      | 'promotion_blocked'
      | 'non_monotonic'
      | 'chain_mismatch'
      | 'tombstoned',
  ) {
    super(message);
    this.name = 'ContractPromotionError';
  }
}

interface ActiveContract {
  manifest: ContractManifest;
  id: string;
}

/**
 * Holds the active contract manifest and swaps in new ones under the same gate
 * as L1Registry: signature verifies, generation strictly increases, prev_hash
 * chains to the active id (compare-and-swap), the id is not tombstoned, and the
 * wrapped contract itself validates. Verify-only — it never signs, so it cannot
 * forge a new active set. Enforcement reads the active enforce-set from here.
 */
export class ContractRegistry {
  private active: ActiveContract | null = null;
  private readonly accepted = new Map<string, ContractManifest>(); // id -> manifest
  private readonly tombstones = new Set<string>(); // dead manifest ids

  constructor(private readonly publicKey: crypto.KeyObject) {}

  /** Validate and atomically swap in a new manifest. Throws
   *  ContractPromotionError on any failure, leaving the previous active. */
  promote(m: ContractManifest): void {
    if (!verifyContractManifest(m, this.publicKey)) {
      throw new ContractPromotionError('manifest signature does not verify', 'bad_signature');
    }

    const id = contractManifestId(m);
    if (this.tombstones.has(id)) {
      throw new ContractPromotionError(`manifest ${id} is tombstoned`, 'tombstoned');
    }

    // Bind envelope to body, then verify the body under the same trusted key.
    if (m.contract_id !== contractId(m.contract)) {
      throw new ContractPromotionError('contract_id does not match contract body', 'contract_unbound');
    }
    if (!verifyContract(m.contract, this.publicKey)) {
      throw new ContractPromotionError('wrapped contract does not verify', 'contract_unverified');
    }
    if (m.contract.promotion_blocked) {
      throw new ContractPromotionError('wrapped contract is promotion_blocked', 'promotion_blocked');
    }
    // Defense in depth: an `enforce` rule that is not `stable` means the ratify
    // gate was bypassed or the body was tampered — reject the whole manifest.
    for (const r of m.contract.rules) {
      if (r.lifecycle === 'enforce' && !r.confidence.stable) {
        throw new ContractPromotionError(
          `enforce rule ${r.id} is below floor`,
          'non_stable_enforce',
        );
      }
    }

    if (this.active === null) {
      if (m.prev_hash !== null) {
        throw new ContractPromotionError('first manifest must have prev_hash null', 'chain_mismatch');
      }
    } else {
      if (m.generation <= this.active.manifest.generation) {
        throw new ContractPromotionError(
          `generation ${m.generation} not greater than active ${this.active.manifest.generation}`,
          'non_monotonic',
        );
      }
      if (m.prev_hash !== this.active.id) {
        throw new ContractPromotionError(
          `prev_hash ${m.prev_hash} does not chain to active ${this.active.id}`,
          'chain_mismatch',
        );
      }
    }

    // Atomic swap — only reached if every check passed.
    this.active = { manifest: m, id };
    this.accepted.set(id, m);
  }

  /** Rules the gate should enforce live. Empty when nothing is promoted. */
  getEnforceRules(): ContractRule[] {
    return this.active ? enforceRulesOf(this.active.manifest.contract) : [];
  }

  getActive(): ContractManifest | null {
    return this.active ? this.active.manifest : null;
  }

  getActiveContract(): BehavioralContract | null {
    return this.active ? this.active.manifest.contract : null;
  }

  getActiveId(): string | null {
    return this.active ? this.active.id : null;
  }

  getGeneration(): number {
    return this.active ? this.active.manifest.generation : 0;
  }

  /** Mark a manifest id operationally dead. A tombstoned id can never be
   *  promoted again, even by replaying its signed envelope. */
  tombstone(id: string): void {
    this.tombstones.add(id);
  }

  isTombstoned(id: string): boolean {
    return this.tombstones.has(id);
  }
}

// ---------------------------------------------------------------------------
// two-phase promote (signed intent → CAS → signed committed)
// ---------------------------------------------------------------------------

export interface PromoteIntent {
  kind: 'contract_promote_intent';
  prior_manifest_hash: string | null; // the compare-and-swap target
  next_generation: number;
  contract_id: string;
  agent: string;
  created_at: string;
  key_fingerprint: string;
  signature: string;
}

export interface PromoteCommitted {
  kind: 'contract_promote_committed';
  manifest_id: string; // the newly active manifest id
  prior_manifest_hash: string | null;
  generation: number;
  contract_id: string;
  agent: string;
  created_at: string;
  key_fingerprint: string;
  signature: string;
}

export interface PromoteResult {
  intent: PromoteIntent;
  manifest: ContractManifest;
  committed: PromoteCommitted;
  generation: number;
  manifest_id: string;
}

export interface PromoteOptions {
  createdAt: string; // promotion timestamp (RFC3339); explicit for determinism
}

function signEnvelope<T extends { signature: string }>(env: T, keys: KeyPair): T {
  const sig = crypto.sign(
    null,
    Buffer.from(canonicalize({ ...env, signature: '' }), 'utf-8'),
    keys.privateKey,
  );
  env.signature = sig.toString('base64');
  return env;
}

/**
 * Promote a ratified contract into `registry` via the spec's two-phase swap:
 * emit a signed `promote_intent` naming the expected prior manifest, build +
 * sign the next manifest, CAS it into the registry (which re-verifies signature,
 * monotonic generation, prev_hash chain, tombstone, and body validity), then
 * emit a signed `promote_committed`. If the CAS is rejected (the active moved
 * under us, a tombstone, a bad body), the registry is unchanged and this throws
 * before any `committed` is produced — fail-closed.
 *
 * The contract must already be ratified (it must carry `enforce` rules);
 * promoting a contract with nothing enforced is a no-op policy and is rejected.
 */
export function promoteContract(
  registry: ContractRegistry,
  ratified: BehavioralContract,
  keys: KeyPair,
  opts: PromoteOptions,
): PromoteResult {
  if (enforceRulesOf(ratified).length === 0) {
    throw new ContractPromotionError('contract has no enforce rules to promote', 'promotion_blocked');
  }

  const prior = registry.getActiveId();
  const generation = registry.getGeneration() + 1;
  const cid = contractId(ratified);

  const intent = signEnvelope<PromoteIntent>(
    {
      kind: 'contract_promote_intent',
      prior_manifest_hash: prior,
      next_generation: generation,
      contract_id: cid,
      agent: ratified.agent,
      created_at: opts.createdAt,
      key_fingerprint: keyFingerprint(keys.publicKey),
      signature: '',
    },
    keys,
  );

  const manifest = signContractManifest(ratified, keys, generation, prior, opts.createdAt);

  // CAS: throws ContractPromotionError and leaves the registry untouched if the
  // active manifest moved, is tombstoned, or the body fails validation.
  registry.promote(manifest);

  const manifestIdStr = registry.getActiveId()!;
  const committed = signEnvelope<PromoteCommitted>(
    {
      kind: 'contract_promote_committed',
      manifest_id: manifestIdStr,
      prior_manifest_hash: prior,
      generation,
      contract_id: cid,
      agent: ratified.agent,
      created_at: opts.createdAt,
      key_fingerprint: keyFingerprint(keys.publicKey),
      signature: '',
    },
    keys,
  );

  return { intent, manifest, committed, generation, manifest_id: manifestIdStr };
}

/** Verify a promote_intent / promote_committed envelope (fail-closed). */
export function verifyPromoteEnvelope(
  env: PromoteIntent | PromoteCommitted,
  publicKey: crypto.KeyObject,
): boolean {
  try {
    if (typeof env.signature !== 'string' || env.signature.length === 0) return false;
    if (env.key_fingerprint !== keyFingerprint(publicKey)) return false;
    const sig = Buffer.from(env.signature, 'base64');
    return crypto.verify(
      null,
      Buffer.from(canonicalize({ ...env, signature: '' }), 'utf-8'),
      publicKey,
      sig,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// operator-readable summary
// ---------------------------------------------------------------------------

/** One-screen summary of what a promote made live. */
export function renderPromotion(result: PromoteResult): string {
  const c = result.manifest.contract;
  const enforced = enforceRulesOf(c);
  const L: string[] = [];
  L.push(`Promoted contract — agent: ${c.agent}`);
  L.push(`generation: ${result.generation}   manifest: ${result.manifest_id}`);
  L.push(`prev: ${result.manifest.prev_hash ?? '(first)'}   contract: ${result.manifest.contract_id}`);
  L.push(`enforce rules (${enforced.length}):`);
  for (const r of enforced) {
    L.push(
      r.kind === 'http_destination'
        ? `  ${r.method} ${r.schemes.join('|')}://${r.host} ${r.path_template}`
        : `  mcp ${r.server}/${r.tool}`,
    );
  }
  return L.join('\n');
}
