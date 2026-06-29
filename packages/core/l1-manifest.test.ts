/**
 * l1-manifest.test.ts — signing, verification, canonicalization, compile (OL-300)
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  signManifest,
  verifyManifest,
  manifestId,
  canonicalize,
  compileManifest,
  keyFingerprint,
  type L1Manifest,
  type ManifestPattern,
} from './l1-manifest.js';

function unsigned(patterns: ManifestPattern[], generation = 1, prev: string | null = null): L1Manifest {
  return {
    kind: 'rai_l1_manifest',
    schema_version: 1,
    generation,
    prev_hash: prev,
    created_at: '2026-05-28T00:00:00.000Z',
    key_fingerprint: '',
    patterns: patterns.map((p) => ({ ...p })), // clone so tamper tests can't pollute shared fixtures
    signature: '',
  };
}

const RULE: ManifestPattern = {
  id: 'r1',
  regex: 'evilcorp',
  flags: 'i',
  label: 'Test exfil host',
  layer: 'L0',
  severity: 'high',
  signal: 'External payload mentions EvilCorp',
};

describe('canonicalize', () => {
  it('is key-order independent', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it('handles nesting and arrays', () => {
    expect(canonicalize({ z: [3, { y: 1, x: 2 }] })).toBe('{"z":[3,{"x":2,"y":1}]}');
  });
});

describe('sign / verify', () => {
  it('round-trips with the signing key', () => {
    const keys = generateKeyPair();
    const m = signManifest(unsigned([RULE]), keys);
    expect(m.signature.length).toBeGreaterThan(0);
    expect(m.key_fingerprint.startsWith('sha256:')).toBe(true);
    expect(verifyManifest(m, keys.publicKey)).toBe(true);
  });

  it('rejects a tampered pattern', () => {
    const keys = generateKeyPair();
    const m = signManifest(unsigned([RULE]), keys);
    m.patterns[0].regex = 'goodcorp'; // mutate after signing
    expect(verifyManifest(m, keys.publicKey)).toBe(false);
  });

  it('rejects a tampered generation', () => {
    const keys = generateKeyPair();
    const m = signManifest(unsigned([RULE]), keys);
    m.generation = 99;
    expect(verifyManifest(m, keys.publicKey)).toBe(false);
  });

  it('rejects the wrong public key', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const m = signManifest(unsigned([RULE]), a);
    expect(verifyManifest(m, b.publicKey)).toBe(false);
  });

  it('rejects an empty signature', () => {
    const keys = generateKeyPair();
    const m = unsigned([RULE]);
    m.key_fingerprint = keyFingerprint(keys.publicKey);
    expect(verifyManifest(m, keys.publicKey)).toBe(false);
  });
});

describe('manifestId', () => {
  it('changes when content changes', () => {
    const keys = generateKeyPair();
    const m1 = signManifest(unsigned([RULE]), keys);
    const m2 = signManifest(unsigned([{ ...RULE, id: 'r2' }]), keys);
    expect(manifestId(m1)).not.toBe(manifestId(m2));
  });
});

describe('compileManifest', () => {
  it('compiles enforce patterns into runtime regexes', () => {
    const compiled = compileManifest(unsigned([RULE]));
    expect(compiled).toHaveLength(1);
    expect(compiled[0].regex.test('Contact EvilCorp now')).toBe(true);
  });

  it('excludes capture_only patterns', () => {
    const compiled = compileManifest(unsigned([{ ...RULE, state: 'capture_only' }]));
    expect(compiled).toHaveLength(0);
  });

  it('throws on an invalid regex (fail-closed)', () => {
    expect(() => compileManifest(unsigned([{ ...RULE, regex: '(' }]))).toThrow();
  });
});
