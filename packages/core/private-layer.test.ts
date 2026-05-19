/**
 * private-layer.test.ts — unit tests for PrivateLayer (Phase 1 private store)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrivateLayer } from './private-layer.js';
import { signatureId, type ThreatSignature } from './threat-signature.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSig(layer: string, label: string): ThreatSignature {
  return {
    id: signatureId(layer as ThreatSignature['layer'], label),
    version: 1,
    layer: layer as ThreatSignature['layer'],
    label,
    pattern_hint: `${layer}:${label}`,
    sample_count: 1,
    confidence: 0.65,
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    source: 'private',
    severity_distribution: { low: 0, medium: 0, high: 0, critical: 1 },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let pl: PrivateLayer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-pl-test-'));
  pl = new PrivateLayer(path.join(tmpDir, 'signatures.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrivateLayer — initial state', () => {
  it('starts empty with no signatures', () => {
    expect(pl.getAllSignatures()).toHaveLength(0);
  });

  it('getLastDreamPhase returns null before first run', () => {
    expect(pl.getLastDreamPhase()).toBeNull();
  });

  it('generates a stable instance_id', () => {
    const id = pl.getInstanceId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('PrivateLayer — upsert + retrieval', () => {
  it('inserts a new signature', () => {
    const sig = makeSig('L0', 'Direct prompt injection');
    pl.upsertSignature(sig);
    expect(pl.getAllSignatures()).toHaveLength(1);
    expect(pl.getSignature(sig.id)).toEqual(sig);
  });

  it('updates an existing signature in place', () => {
    const sig = makeSig('L0', 'Direct prompt injection');
    pl.upsertSignature(sig);
    const updated = { ...sig, version: 2, sample_count: 10 };
    pl.upsertSignature(updated);
    expect(pl.getAllSignatures()).toHaveLength(1);
    expect(pl.getSignature(sig.id)?.sample_count).toBe(10);
    expect(pl.getSignature(sig.id)?.version).toBe(2);
  });

  it('getSignature returns null for unknown id', () => {
    expect(pl.getSignature('deadbeef00000000')).toBeNull();
  });

  it('stores multiple signatures independently', () => {
    pl.upsertSignature(makeSig('L0', 'a'));
    pl.upsertSignature(makeSig('L-1', 'b'));
    pl.upsertSignature(makeSig('L-2', 'c'));
    expect(pl.getAllSignatures()).toHaveLength(3);
  });
});

describe('PrivateLayer — persistence', () => {
  it('persists signatures to disk and reloads on a fresh instance', () => {
    const sig = makeSig('L0', 'persisted-label');
    pl.upsertSignature(sig);

    const pl2 = new PrivateLayer(pl.getStorePath());
    expect(pl2.getAllSignatures()).toHaveLength(1);
    expect(pl2.getSignature(sig.id)).toEqual(sig);
  });

  it('preserves instance_id across reload', () => {
    const id1 = pl.getInstanceId();
    // trigger write
    pl.upsertSignature(makeSig('L0', 'any'));
    const pl2 = new PrivateLayer(pl.getStorePath());
    expect(pl2.getInstanceId()).toBe(id1);
  });
});

describe('PrivateLayer — dream-phase bookkeeping', () => {
  it('recordDreamPhase stamps a timestamp', () => {
    pl.recordDreamPhase();
    expect(pl.getLastDreamPhase()).not.toBeNull();
  });

  it('increments dream_phase_count on each call', () => {
    pl.recordDreamPhase();
    pl.recordDreamPhase();
    const summary = pl.summarize();
    expect(summary.dream_phase_count).toBe(2);
  });
});

describe('PrivateLayer — summarize', () => {
  it('returns correct by_layer counts', () => {
    pl.upsertSignature(makeSig('L0', 'a'));
    pl.upsertSignature(makeSig('L0', 'b'));
    pl.upsertSignature(makeSig('L-1', 'c'));
    const s = pl.summarize();
    expect(s.total).toBe(3);
    expect(s.by_layer['L0']).toBe(2);
    expect(s.by_layer['L-1']).toBe(1);
  });
});

describe('PrivateLayer — clear', () => {
  it('clears all signatures but keeps instance_id', () => {
    const id = pl.getInstanceId();
    pl.upsertSignature(makeSig('L0', 'to-be-cleared'));
    pl.recordDreamPhase();
    pl.clear();
    expect(pl.getAllSignatures()).toHaveLength(0);
    expect(pl.getLastDreamPhase()).toBeNull();
    expect(pl.getInstanceId()).toBe(id);
  });
});
