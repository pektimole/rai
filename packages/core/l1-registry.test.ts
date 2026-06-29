/**
 * l1-registry.test.ts — atomic promotion gates: signature, monotonicity,
 * chain compare-and-swap, tombstones (OL-300)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { L1Registry, PromotionError } from './l1-registry.js';
import {
  generateKeyPair,
  signManifest,
  manifestId,
  type KeyPair,
  type L1Manifest,
  type ManifestPattern,
} from './l1-manifest.js';

const RULE: ManifestPattern = {
  id: 'r1',
  regex: 'evilcorp',
  flags: 'i',
  label: 'Test',
  layer: 'L0',
  severity: 'high',
  signal: 'mentions EvilCorp',
};

function gen(
  keys: KeyPair,
  generation: number,
  prev: string | null,
  patterns: ManifestPattern[] = [RULE],
): L1Manifest {
  return signManifest(
    {
      kind: 'rai_l1_manifest',
      schema_version: 1,
      generation,
      prev_hash: prev,
      created_at: '2026-05-28T00:00:00.000Z',
      key_fingerprint: '',
      patterns: patterns.map((p) => ({ ...p })), // clone so tamper tests can't pollute fixtures
      signature: '',
    },
    keys,
  );
}

let keys: KeyPair;
let reg: L1Registry;

beforeEach(() => {
  keys = generateKeyPair();
  reg = new L1Registry(keys.publicKey);
});

describe('promote', () => {
  it('accepts a valid first manifest and exposes its patterns', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    expect(reg.getGeneration()).toBe(1);
    expect(reg.getActiveId()).toBe(manifestId(g1));
    expect(reg.getActivePatterns()).toHaveLength(1);
  });

  it('chains generation 2 onto generation 1', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    const g2 = gen(keys, 2, manifestId(g1), [RULE, { ...RULE, id: 'r2' }]);
    reg.promote(g2);
    expect(reg.getGeneration()).toBe(2);
    expect(reg.getActivePatterns()).toHaveLength(2);
  });

  it('rejects a first manifest with a non-null prev_hash', () => {
    expect(() => reg.promote(gen(keys, 1, 'deadbeef'))).toThrow(PromotionError);
  });

  it('rejects a bad signature and keeps the previous active (fail-closed)', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    const g2 = gen(keys, 2, manifestId(g1));
    g2.patterns[0].regex = 'tampered';
    expect(() => reg.promote(g2)).toThrow(/signature/);
    expect(reg.getGeneration()).toBe(1); // unchanged
  });

  it('rejects a non-monotonic generation (replay)', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    const g2 = gen(keys, 2, manifestId(g1));
    reg.promote(g2);
    expect(() => reg.promote(g1)).toThrow(/generation/);
  });

  it('rejects a chain mismatch', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    const bad = gen(keys, 2, 'wronghash');
    expect(() => reg.promote(bad)).toThrow(/chain/);
  });

  it('rejects a compile failure', () => {
    const g1 = gen(keys, 1, null, [{ ...RULE, regex: '(' }]);
    expect(() => reg.promote(g1)).toThrow(/compile/);
  });
});

describe('tombstones', () => {
  it('refuses to re-promote a tombstoned manifest id', () => {
    const g1 = gen(keys, 1, null);
    reg.promote(g1);
    const g2 = gen(keys, 2, manifestId(g1));
    reg.promote(g2);
    reg.tombstone(manifestId(g2));
    expect(reg.isTombstoned(manifestId(g2))).toBe(true);
    // a fresh registry asked to promote the tombstoned manifest must refuse
    const reg2 = new L1Registry(keys.publicKey);
    reg2.tombstone(manifestId(g1));
    expect(() => reg2.promote(g1)).toThrow(/tombstoned/);
  });
});
