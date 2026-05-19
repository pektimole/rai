/**
 * dream-phase.test.ts — unit tests for distillScanLog + runDreamPhase
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { distillScanLog, runDreamPhase } from './dream-phase.js';
import { signatureId, computeConfidence } from './threat-signature.js';
import { ScanLog } from './scan-log.js';
import { PrivateLayer } from './private-layer.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MiniEntry {
  timestamp: string;
  scan_id: string;
  tier: 'p0';
  channel: string;
  verdict: string;
  confidence: number;
  recommended_action: string;
  threat_layers: Array<{ layer: string; label: string; severity: string }>;
}

function makeEntry(
  layer: string,
  label: string,
  severity: string,
  timestamp = new Date().toISOString(),
): MiniEntry {
  return {
    timestamp,
    scan_id: `test-${Math.random().toString(36).slice(2)}`,
    tier: 'p0',
    channel: 'telegram',
    verdict: 'blocked',
    confidence: 0.97,
    recommended_action: 'block',
    threat_layers: [{ layer, label, severity }],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let scanLog: ScanLog;
let pl: PrivateLayer;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-dp-test-'));
  scanLog = new ScanLog(tmpDir);
  pl = new PrivateLayer(path.join(tmpDir, 'signatures.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// distillScanLog
// ---------------------------------------------------------------------------

describe('distillScanLog', () => {
  it('returns empty map for empty input', () => {
    expect(distillScanLog([])).toEqual(new Map());
  });

  it('groups entries by layer+label', () => {
    const entries = [
      makeEntry('L0', 'Direct prompt injection', 'critical'),
      makeEntry('L0', 'Direct prompt injection', 'critical'),
      makeEntry('L-1', 'Persona replacement', 'high'),
    ];
    const acc = distillScanLog(entries as Parameters<typeof distillScanLog>[0]);
    expect(acc.size).toBe(2);

    const id = signatureId('L0', 'Direct prompt injection');
    expect(acc.get(id)?.severity_distribution.critical).toBe(2);
    expect(acc.get(id)?.severity_distribution.high).toBe(0);

    const id2 = signatureId('L-1', 'Persona replacement');
    expect(acc.get(id2)?.severity_distribution.high).toBe(1);
  });

  it('tracks last_seen correctly', () => {
    const entries = [
      makeEntry('L0', 'test', 'high', '2026-01-01T10:00:00.000Z'),
      makeEntry('L0', 'test', 'high', '2026-01-03T10:00:00.000Z'),
      makeEntry('L0', 'test', 'high', '2026-01-02T10:00:00.000Z'),
    ];
    const acc = distillScanLog(entries as Parameters<typeof distillScanLog>[0]);
    const id = signatureId('L0', 'test');
    expect(acc.get(id)?.last_seen).toBe('2026-01-03T10:00:00.000Z');
    expect(acc.get(id)?.first_seen).toBe('2026-01-01T10:00:00.000Z');
  });

  it('filters entries strictly after since', () => {
    const entries = [
      makeEntry('L0', 'test', 'high', '2026-01-01T00:00:00.000Z'),
      makeEntry('L0', 'test', 'high', '2026-01-01T12:00:00.000Z'), // boundary — excluded
      makeEntry('L0', 'test', 'high', '2026-01-02T00:00:00.000Z'), // included
    ];
    const acc = distillScanLog(
      entries as Parameters<typeof distillScanLog>[0],
      '2026-01-01T12:00:00.000Z',
    );
    const id = signatureId('L0', 'test');
    // Only the Jan 2 entry passes the since filter
    expect(acc.get(id)?.severity_distribution.high).toBe(1);
  });

  it('handles multiple threat_layers per scan entry', () => {
    const entry = {
      ...makeEntry('L0', 'a', 'critical'),
      threat_layers: [
        { layer: 'L0', label: 'a', severity: 'critical' },
        { layer: 'L-1', label: 'b', severity: 'high' },
      ],
    };
    const acc = distillScanLog([entry] as Parameters<typeof distillScanLog>[0]);
    expect(acc.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeConfidence
// ---------------------------------------------------------------------------

describe('computeConfidence', () => {
  it('returns 0 for empty distribution', () => {
    expect(computeConfidence({ low: 0, medium: 0, high: 0, critical: 0 })).toBe(0);
  });

  it('single critical hit → roughly 0.65', () => {
    const c = computeConfidence({ low: 0, medium: 0, high: 0, critical: 1 });
    expect(c).toBeGreaterThan(0.6);
    expect(c).toBeLessThan(0.75);
  });

  it('confidence increases with more samples', () => {
    const one = computeConfidence({ low: 0, medium: 0, high: 0, critical: 1 });
    const ten = computeConfidence({ low: 0, medium: 0, high: 0, critical: 10 });
    expect(ten).toBeGreaterThan(one);
  });

  it('low-severity distribution produces lower confidence than critical', () => {
    const low = computeConfidence({ low: 5, medium: 0, high: 0, critical: 0 });
    const crit = computeConfidence({ low: 0, medium: 0, high: 0, critical: 5 });
    expect(crit).toBeGreaterThan(low);
  });

  it('confidence is always in [0, 1]', () => {
    const c = computeConfidence({ low: 100, medium: 100, high: 100, critical: 100 });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// runDreamPhase
// ---------------------------------------------------------------------------

describe('runDreamPhase', () => {
  it('returns zero counts for empty scan log', async () => {
    const result = await runDreamPhase({ scanLog, privateLayer: pl });
    expect(result.scans_processed).toBe(0);
    expect(result.signatures_created).toBe(0);
    expect(result.signatures_updated).toBe(0);
    expect(result.new_patterns).toEqual([]);
    // Empty log: no dream-phase recorded on store (idempotent)
    expect(pl.getLastDreamPhase()).toBeNull();
  });

  it('creates new signatures from scan entries', async () => {
    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'critical') as Parameters<typeof scanLog.logScan>[0]);
    scanLog.logScan(makeEntry('L-1', 'Persona replacement', 'high') as Parameters<typeof scanLog.logScan>[0]);

    const result = await runDreamPhase({ scanLog, privateLayer: pl });
    expect(result.scans_processed).toBe(2);
    expect(result.signatures_created).toBe(2);
    expect(result.signatures_updated).toBe(0);
    expect(pl.getAllSignatures()).toHaveLength(2);
  });

  it('increments version on second run with same pattern', async () => {
    // Use explicit past timestamps so `since` filtering is deterministic
    const T1 = '2026-01-01T10:00:00.000Z';
    const T2 = '2026-01-02T10:00:00.000Z';
    const BETWEEN = '2026-01-01T18:00:00.000Z'; // between T1 and T2

    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'critical', T1) as Parameters<typeof scanLog.logScan>[0]);
    // First run: full history → version=1, sample_count=1
    await runDreamPhase({ scanLog, privateLayer: pl, since: null });

    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'critical', T2) as Parameters<typeof scanLog.logScan>[0]);
    // Second run: incremental, only entries after BETWEEN → merges T2 entry only
    const result = await runDreamPhase({ scanLog, privateLayer: pl, since: BETWEEN });

    expect(result.signatures_updated).toBe(1);
    expect(result.signatures_created).toBe(0);
    const id = signatureId('L0', 'Direct prompt injection');
    expect(pl.getSignature(id)?.version).toBe(2);
    expect(pl.getSignature(id)?.sample_count).toBe(2);
  });

  it('accumulates severity distribution across runs', async () => {
    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'critical') as Parameters<typeof scanLog.logScan>[0]);
    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'high') as Parameters<typeof scanLog.logScan>[0]);
    await runDreamPhase({ scanLog, privateLayer: pl, since: null });

    const id = signatureId('L0', 'Direct prompt injection');
    const sig = pl.getSignature(id);
    expect(sig?.severity_distribution.critical).toBe(1);
    expect(sig?.severity_distribution.high).toBe(1);
    expect(sig?.sample_count).toBe(2);
  });

  it('marks last_dream_phase after successful run', async () => {
    scanLog.logScan(makeEntry('L0', 'any', 'high') as Parameters<typeof scanLog.logScan>[0]);
    await runDreamPhase({ scanLog, privateLayer: pl });
    expect(pl.getLastDreamPhase()).not.toBeNull();
  });

  it('new_patterns lists layer:label for first-time patterns', async () => {
    scanLog.logScan(makeEntry('L0', 'Direct prompt injection', 'critical') as Parameters<typeof scanLog.logScan>[0]);
    const result = await runDreamPhase({ scanLog, privateLayer: pl });
    expect(result.new_patterns).toContain('L0:Direct prompt injection');
  });

  it('source is always private in Phase 1', async () => {
    scanLog.logScan(makeEntry('L0', 'test', 'high') as Parameters<typeof scanLog.logScan>[0]);
    await runDreamPhase({ scanLog, privateLayer: pl });
    const sigs = pl.getAllSignatures();
    expect(sigs.every((s) => s.source === 'private')).toBe(true);
  });

  it('result contains valid ISO timestamps', async () => {
    scanLog.logScan(makeEntry('L0', 'test', 'high') as Parameters<typeof scanLog.logScan>[0]);
    const result = await runDreamPhase({ scanLog, privateLayer: pl });
    expect(() => new Date(result.started_at)).not.toThrow();
    expect(() => new Date(result.completed_at)).not.toThrow();
    expect(result.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
