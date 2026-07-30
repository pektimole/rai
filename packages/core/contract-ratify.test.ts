/**
 * contract-ratify.test.ts — ratify + promote (OL-461, phase 4)
 *
 * Proves the two-step activation: ratify flips only eligible (stable) rules to
 * `enforce` and re-signs (a below-floor rule can never be ratified), and promote
 * swaps the ratified contract in under the same gated CAS as L1Registry —
 * signature, monotonic generation, prev_hash chain, tombstone, and body
 * validity — so a stale or forged swap is rejected fail-closed. Contracts are
 * built through the real compiler and signed with a real Ed25519 key.
 */

import * as crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { compileContract, contractId, signContract, type BehavioralContract } from './contract-compile.js';
import { canonicalize, generateKeyPair, keyFingerprint, type KeyPair } from './l1-manifest.js';
import type { FlightEvent, FlightSession } from './contract-recorder.js';
import {
  ratifyContract,
  RatifyError,
  enforceRulesOf,
  ContractRegistry,
  ContractPromotionError,
  promoteContract,
  signContractManifest,
  verifyContractManifest,
  contractManifestId,
  verifyPromoteEnvelope,
  renderPromotion,
} from './contract-ratify.js';

// --- fixtures --------------------------------------------------------------

const H0 = '2026-01-01T00';
const H1 = '2026-01-01T01';
const AT = '2026-01-02T00:00:00Z'; // promotion timestamp

const USERS = 'http:api.example.com:GET:/users/<id>';
const SEARCH = 'mcp:gmail:search';
const SEND = 'mcp:gmail:send';

function http(path: string, ts: string): { ts: string; event: FlightEvent } {
  return {
    ts,
    event: { kind: 'http_destination', scheme: 'https', host: 'api.example.com', port: 443, method: 'GET', path },
  };
}
function mcp(server: string, tool: string, ts: string): { ts: string; event: FlightEvent } {
  return { ts, event: { kind: 'mcp_tool_call', server, tool } };
}
function session(id: string, events: Array<{ ts: string; event: FlightEvent }>): FlightSession {
  return { session_id: id, agent: 'agent-a', created_at: `${H0}:00:00Z`, events };
}

/** Stable /users/<id> and gmail/search, unstable gmail/send (same shape the
 *  shadow suite uses), signed under `keys`. */
function signedContract(keys: KeyPair): BehavioralContract {
  const sessions: FlightSession[] = [
    session('h1', [http('/users/1', `${H0}:00:00Z`), http('/users/2', `${H0}:05:00Z`), http('/users/3', `${H1}:00:00Z`), http('/users/4', `${H1}:05:00Z`)]),
    session('h2', [http('/users/5', `${H0}:10:00Z`), http('/users/6', `${H0}:15:00Z`), http('/users/7', `${H1}:10:00Z`), http('/users/8', `${H1}:15:00Z`)]),
    session('m1', [mcp('gmail', 'search', `${H0}:00:00Z`), mcp('gmail', 'search', `${H0}:05:00Z`), mcp('gmail', 'search', `${H1}:00:00Z`), mcp('gmail', 'search', `${H1}:05:00Z`)]),
    session('m2', [mcp('gmail', 'search', `${H0}:10:00Z`), mcp('gmail', 'search', `${H0}:15:00Z`), mcp('gmail', 'search', `${H1}:10:00Z`), mcp('gmail', 'search', `${H1}:15:00Z`), mcp('gmail', 'send', `${H1}:20:00Z`)]),
  ];
  // acceptTail: the gmail/send one-off is a >5% tail on the gmail server; accept
  // it so the contract is promotion-eligible while still carrying an unstable
  // rule (which must stay proposed and never be ratifiable).
  const c = compileContract('agent-a', sessions, { createdAt: `${H0}:00:00Z`, acceptTail: true });
  return signContract(c, keys);
}

// --- ratify ----------------------------------------------------------------

describe('ratifyContract', () => {
  it('flips every stable rule to enforce and leaves unstable ones proposed', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    const r = ratifyContract(c, keys);

    const ids = enforceRulesOf(r).map((x) => x.id).sort();
    expect(ids).toEqual([USERS, SEARCH].sort());
    // the unstable send rule stays proposed
    expect(r.rules.find((x) => x.id === SEND)?.lifecycle).toBe('proposed');
    // re-signed and verifiable, with a new content id
    expect(r.signature).not.toBe('');
    expect(contractId(r)).not.toBe(contractId(c));
    expect(r.key_fingerprint).toBe(keyFingerprint(keys.publicKey));
  });

  it('does not mutate the input contract', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    const beforeId = contractId(c);
    ratifyContract(c, keys);
    expect(contractId(c)).toBe(beforeId);
    expect(c.rules.every((x) => x.lifecycle === 'proposed')).toBe(true);
  });

  it('honors an explicit stable subset', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    const r = ratifyContract(c, keys, { ruleIds: [SEARCH] });
    expect(enforceRulesOf(r).map((x) => x.id)).toEqual([SEARCH]);
    expect(r.rules.find((x) => x.id === USERS)?.lifecycle).toBe('proposed');
  });

  it('refuses to ratify a below-floor rule (the "5 events" anti-pattern)', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    expect(() => ratifyContract(c, keys, { ruleIds: [SEND] })).toThrow(RatifyError);
    try {
      ratifyContract(c, keys, { ruleIds: [SEND] });
    } catch (e) {
      expect((e as RatifyError).code).toBe('non_stable_rule');
    }
  });

  it('rejects an unknown rule id', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    expect(() => ratifyContract(c, keys, { ruleIds: ['http:nope'] })).toThrow(/no such rule/);
  });

  it('refuses a tampered candidate (signature no longer verifies)', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    const tampered = { ...c, agent: 'agent-evil' }; // body changed, signature stale
    expect(() => ratifyContract(tampered, keys)).toThrow(RatifyError);
  });

  it('refuses a contract signed by a different key', () => {
    const keys = generateKeyPair();
    const other = generateKeyPair();
    const c = signedContract(other);
    expect(() => ratifyContract(c, keys)).toThrow(/does not verify/);
  });

  it('rejects a promotion_blocked contract', () => {
    const keys = generateKeyPair();
    // one host, one path, single session/window → no stable rule → blocked.
    const c = signContract(
      compileContract('agent-a', [session('s', [http('/users/1', `${H0}:00:00Z`)])], { createdAt: `${H0}:00:00Z` }),
      keys,
    );
    expect(c.promotion_blocked).toBe(true);
    expect(() => ratifyContract(c, keys)).toThrow(/blocked/);
  });

  it('is idempotent: re-ratifying the same selection reproduces the same body', () => {
    const keys = generateKeyPair();
    const c = signedContract(keys);
    const r1 = ratifyContract(c, keys);
    const r2 = ratifyContract(r1, keys);
    expect(contractId(r2)).toBe(contractId(r1));
  });
});

// --- manifest envelope -----------------------------------------------------

describe('contract manifest envelope', () => {
  it('signs, verifies, and binds to the exact contract id', () => {
    const keys = generateKeyPair();
    const r = ratifyContract(signedContract(keys), keys);
    const m = signContractManifest(r, keys, 1, null, AT);
    expect(verifyContractManifest(m, keys.publicKey)).toBe(true);
    expect(m.contract_id).toBe(contractId(r));
    // tamper the envelope → verification fails
    const bad = { ...m, generation: 2 };
    expect(verifyContractManifest(bad, keys.publicKey)).toBe(false);
  });
});

// --- promote ---------------------------------------------------------------

describe('promoteContract — first activation', () => {
  it('activates the ratified contract and exposes the enforce-set', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(keys), keys);

    const res = promoteContract(reg, r, keys, { createdAt: AT });
    expect(res.generation).toBe(1);
    expect(reg.getGeneration()).toBe(1);
    expect(reg.getActiveId()).toBe(res.manifest_id);
    expect(reg.getEnforceRules().map((x) => x.id).sort()).toEqual([USERS, SEARCH].sort());

    // both envelopes are signed and chain-consistent
    expect(verifyPromoteEnvelope(res.intent, keys.publicKey)).toBe(true);
    expect(verifyPromoteEnvelope(res.committed, keys.publicKey)).toBe(true);
    expect(res.intent.prior_manifest_hash).toBeNull();
    expect(res.committed.manifest_id).toBe(res.manifest_id);
    expect(res.manifest_id).toBe(contractManifestId(res.manifest));
  });

  it('rejects a first manifest whose prev_hash is not null', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(keys), keys);
    const m = signContractManifest(r, keys, 1, 'sha256:bogus', AT);
    expect(() => reg.promote(m)).toThrow(ContractPromotionError);
  });

  it('refuses to promote a contract with nothing enforced', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const c = signedContract(keys); // never ratified → all proposed
    expect(() => promoteContract(reg, c, keys, { createdAt: AT })).toThrow(/no enforce rules/);
  });
});

// --- promote chain + CAS ---------------------------------------------------

describe('promoteContract — chain + compare-and-swap', () => {
  it('chains a second promotion onto the first (monotonic generation)', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r1 = ratifyContract(signedContract(keys), keys);
    const first = promoteContract(reg, r1, keys, { createdAt: AT });

    // ratify a narrower set, promote again
    const r2 = ratifyContract(signedContract(keys), keys, { ruleIds: [USERS] });
    const second = promoteContract(reg, r2, keys, { createdAt: '2026-01-03T00:00:00Z' });

    expect(second.generation).toBe(2);
    expect(second.manifest.prev_hash).toBe(first.manifest_id);
    expect(reg.getGeneration()).toBe(2);
    expect(reg.getEnforceRules().map((x) => x.id)).toEqual([USERS]);
  });

  it('rejects a stale swap: prev_hash no longer chains to the active id', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r1 = ratifyContract(signedContract(keys), keys);
    promoteContract(reg, r1, keys, { createdAt: AT }); // active is now gen 1

    // hand-build a gen-2 manifest that chains to the FIRST-manifest slot (null),
    // as a racing promoter who read a stale prior would.
    const stale = signContractManifest(r1, keys, 2, null, AT);
    expect(() => reg.promote(stale)).toThrow(ContractPromotionError);
    expect(reg.getGeneration()).toBe(1); // unchanged — fail-closed
  });

  it('rejects a non-monotonic generation', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r1 = ratifyContract(signedContract(keys), keys);
    const first = promoteContract(reg, r1, keys, { createdAt: AT });
    // same generation, correctly chained → still rejected (not strictly greater)
    const dup = signContractManifest(r1, keys, 1, first.manifest_id, AT);
    expect(() => reg.promote(dup)).toThrow(/not greater/);
  });
});

// --- tombstone + tamper defenses -------------------------------------------

describe('ContractRegistry — hard defenses', () => {
  it('a tombstoned manifest can never be promoted, even by replay', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(keys), keys);
    const m = signContractManifest(r, keys, 1, null, AT);
    const id = contractManifestId(m);
    reg.tombstone(id);
    expect(reg.isTombstoned(id)).toBe(true);
    expect(() => reg.promote(m)).toThrow(/tombstoned/);
  });

  it('rejects a manifest signed by a foreign key', () => {
    const keys = generateKeyPair();
    const foreign = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(foreign), foreign);
    const m = signContractManifest(r, foreign, 1, null, AT);
    expect(() => reg.promote(m)).toThrow(/signature does not verify/);
  });

  it('rejects an enforce rule that is not stable (ratify-gate bypass)', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    // forge: flip the unstable send rule to enforce, then re-sign as if valid.
    const c = signedContract(keys);
    const forged: BehavioralContract = signContract(
      {
        ...c,
        key_fingerprint: '',
        signature: '',
        rules: c.rules.map((x) => (x.id === SEND ? { ...structuredClone(x), lifecycle: 'enforce' as const } : structuredClone(x))),
      },
      keys,
    );
    const m = signContractManifest(forged, keys, 1, null, AT);
    expect(() => reg.promote(m)).toThrow(/below floor/);
  });

  it('rejects a manifest whose contract_id does not bind its body', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(keys), keys);
    const m = signContractManifest(r, keys, 1, null, AT);
    // rebind to a different body but keep the (now-wrong) contract_id, re-sign
    // the envelope so only the binding check can catch it.
    const otherBody = ratifyContract(signedContract(keys), keys, { ruleIds: [USERS] });
    const rebound = { ...m, contract: otherBody };
    const sig = crypto.sign(
      null,
      Buffer.from(canonicalize({ ...rebound, signature: '' }), 'utf-8'),
      keys.privateKey,
    );
    rebound.signature = sig.toString('base64');
    expect(() => reg.promote(rebound)).toThrow(/does not match/);
  });
});

// --- render ----------------------------------------------------------------

describe('renderPromotion', () => {
  it('summarizes the active generation and enforce-set', () => {
    const keys = generateKeyPair();
    const reg = new ContractRegistry(keys.publicKey);
    const r = ratifyContract(signedContract(keys), keys);
    const res = promoteContract(reg, r, keys, { createdAt: AT });
    const text = renderPromotion(res);
    expect(text).toContain('agent: agent-a');
    expect(text).toContain('generation: 1');
    expect(text).toContain(res.manifest_id);
    expect(text).toContain('/users/<id>');
  });
});
