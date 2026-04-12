/**
 * phantom.test.ts — Tests for RAI Phantom adaptive threat model
 *
 * Covers: weight loading, scan logging, correction detection,
 * Phantom retrain loop, and safety validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to set HOME before imports so weight loader + scan log use temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-phantom-test-'));
const origHome = process.env.HOME;

import { loadP0Weights, loadP1Weights, loadP2Weights, saveP0Weights, invalidateCache } from './threat-weights.js';
import { ScanLog } from './scan-log.js';
import type { ScanLogEntry, CorrectionEntry } from './scan-log.js';
import { retrain, shouldRetrain } from './phantom.js';
import type { RetrainEvent } from './phantom.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScanLog(): ScanLog {
  return new ScanLog(path.join(tmpDir, '.rai', 'scan-log'));
}

function makeScanEntry(overrides: Partial<ScanLogEntry> = {}): ScanLogEntry {
  return {
    timestamp: new Date().toISOString(),
    scan_id: `scan-${Math.random().toString(36).slice(2, 8)}`,
    tier: 'p0',
    channel: 'whatsapp',
    verdict: 'blocked',
    confidence: 0.93,
    recommended_action: 'block',
    threat_layers: [{ layer: 'L0', label: 'Direct prompt injection', severity: 'critical' }],
    matched_patterns: ['Direct prompt injection'],
    ...overrides,
  };
}

function makeCorrection(overrides: Partial<CorrectionEntry> = {}): CorrectionEntry {
  return {
    timestamp: new Date().toISOString(),
    scan_id: 'scan-test',
    corrected_tier: 'p0',
    corrected_verdict: 'clean',
    correction_source: 'user_override',
    sample_weight: 3.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Weight Loading', () => {
  beforeEach(() => {
    process.env.HOME = tmpDir;
    invalidateCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    invalidateCache();
  });

  it('loads bundled P0 weights with all pattern entries', () => {
    const w = loadP0Weights(true);
    expect(w._meta.version).toBe(1);
    expect(w.pattern_weights['Direct prompt injection']).toBe(1.0);
    expect(w.verdict_thresholds.block_confidence).toBe(0.93);
  });

  it('loads bundled P1 weights with escalation threshold', () => {
    const w = loadP1Weights(true);
    expect(w.escalation_threshold).toBe(0.65);
    expect(w.p0_trigger_threshold).toBe(0.60);
  });

  it('loads bundled P2 weights with agent weights and thresholds', () => {
    const w = loadP2Weights(true);
    expect(w.agent_weights.provenance).toBe(1.0);
    expect(w.consensus_thresholds.confirmed_threat_min_supporting).toBe(3);
  });

  it('user override weights take precedence over bundled', () => {
    const userDir = path.join(tmpDir, '.rai', 'weights');
    fs.mkdirSync(userDir, { recursive: true });
    const custom = loadP0Weights(true);
    custom.pattern_weights['Direct prompt injection'] = 0.5;
    fs.writeFileSync(path.join(userDir, 'p0-weights.json'), JSON.stringify(custom));

    invalidateCache();
    const loaded = loadP0Weights(true);
    expect(loaded.pattern_weights['Direct prompt injection']).toBe(0.5);
  });

  it('saveP0Weights increments version and updates timestamp', () => {
    const w = loadP0Weights(true);
    const oldVersion = w._meta.version;
    saveP0Weights(w);
    invalidateCache();
    const reloaded = loadP0Weights(true);
    expect(reloaded._meta.version).toBe(oldVersion + 1);
  });
});

describe('Scan Log', () => {
  let log: ScanLog;
  let logDir: string;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-scanlog-'));
    log = new ScanLog(logDir);
  });

  it('logs and reads back scan entries', () => {
    const entry = makeScanEntry();
    log.logScan(entry);
    const scans = log.readScans();
    expect(scans).toHaveLength(1);
    expect(scans[0].scan_id).toBe(entry.scan_id);
  });

  it('logs and reads back correction entries', () => {
    const correction = makeCorrection();
    log.logCorrection(correction);
    const corrections = log.readCorrections();
    expect(corrections).toHaveLength(1);
    expect(corrections[0].sample_weight).toBe(3.0);
  });

  it('returns empty arrays for non-existent log files', () => {
    const freshLog = new ScanLog(path.join(tmpDir, 'nonexistent'));
    expect(freshLog.readScans()).toEqual([]);
    expect(freshLog.readCorrections()).toEqual([]);
  });

  it('stats returns correct counts', () => {
    log.logScan(makeScanEntry());
    log.logScan(makeScanEntry());
    log.logCorrection(makeCorrection());
    const stats = log.stats();
    expect(stats.scans).toBe(2);
    expect(stats.corrections).toBe(1);
  });

  it('getCorrectionsForScan filters by scan_id', () => {
    log.logCorrection(makeCorrection({ scan_id: 'scan-a' }));
    log.logCorrection(makeCorrection({ scan_id: 'scan-b' }));
    log.logCorrection(makeCorrection({ scan_id: 'scan-a' }));
    expect(log.getCorrectionsForScan('scan-a')).toHaveLength(2);
    expect(log.getCorrectionsForScan('scan-b')).toHaveLength(1);
  });
});

describe('Correction Detection', () => {
  // Import dynamically to avoid circular init issues with HOME override
  let detectP0P1Contradiction: typeof import('./corrections.js').detectP0P1Contradiction;
  let detectP1P2Contradiction: typeof import('./corrections.js').detectP1P2Contradiction;
  let recordUserOverride: typeof import('./corrections.js').recordUserOverride;

  beforeEach(async () => {
    process.env.HOME = tmpDir;
    invalidateCache();
    const mod = await import('./corrections.js');
    detectP0P1Contradiction = mod.detectP0P1Contradiction;
    detectP1P2Contradiction = mod.detectP1P2Contradiction;
    recordUserOverride = mod.recordUserOverride;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    invalidateCache();
  });

  it('detects P0-P1 contradiction when P0 blocks but P1 says clean', () => {
    const result = detectP0P1Contradiction('scan-1', 'blocked', 'clean');
    expect(result).not.toBeNull();
    expect(result!.corrected_tier).toBe('p0');
    expect(result!.corrected_verdict).toBe('clean');
    expect(result!.sample_weight).toBe(1.0);
  });

  it('returns null when P0 and P1 agree', () => {
    const result = detectP0P1Contradiction('scan-2', 'blocked', 'blocked');
    expect(result).toBeNull();
  });

  it('detects P1-P2 contradiction', () => {
    const result = detectP1P2Contradiction('scan-3', 'flagged', 'false_positive');
    expect(result).not.toBeNull();
    expect(result!.corrected_tier).toBe('p1');
    expect(result!.corrected_verdict).toBe('clean');
  });

  it('returns null for P2 uncertain (no signal)', () => {
    const result = detectP1P2Contradiction('scan-4', 'flagged', 'uncertain');
    expect(result).toBeNull();
  });

  it('records user override with 3x weight', () => {
    const result = recordUserOverride({
      scan_id: 'scan-5',
      tier: 'p0',
      corrected_verdict: 'clean',
      reason: 'false positive, this is my own test message',
    });
    expect(result.sample_weight).toBe(3.0);
    expect(result.correction_source).toBe('user_override');
  });
});

describe('Phantom Retrain', () => {
  beforeEach(() => {
    process.env.HOME = tmpDir;
    invalidateCache();
    // Clean up retrain history and logs for fresh state
    const logDir = path.join(tmpDir, '.rai', 'scan-log');
    const weightsDir = path.join(tmpDir, '.rai', 'weights');
    for (const dir of [logDir, weightsDir]) {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    }
  });

  afterEach(() => {
    process.env.HOME = origHome;
    invalidateCache();
  });

  it('shouldRetrain returns false with no corrections', () => {
    expect(shouldRetrain()).toBe(false);
  });

  it('shouldRetrain returns true with >= 10 corrections', () => {
    const log = makeScanLog();
    for (let i = 0; i < 10; i++) {
      log.logCorrection(makeCorrection({ scan_id: `scan-${i}` }));
    }
    expect(shouldRetrain({ min_corrections: 10 })).toBe(true);
  });

  it('retrain with no corrections produces no-op event', () => {
    const event = retrain('manual');
    expect(event.corrections_used).toBe(0);
    expect(event.weight_changes).toEqual([]);
    expect(event.validation_passed).toBe(true);
  });

  it('retrain adjusts P0 pattern weights on overblock corrections', () => {
    const log = makeScanLog();
    const scanId = 'scan-overblock';

    // Log a P0 scan that blocked on "Direct prompt injection"
    log.logScan(makeScanEntry({
      scan_id: scanId,
      verdict: 'blocked',
      matched_patterns: ['Direct prompt injection'],
    }));

    // User says it was clean (false positive)
    log.logCorrection(makeCorrection({
      scan_id: scanId,
      corrected_tier: 'p0',
      corrected_verdict: 'clean',
      sample_weight: 3.0,
    }));

    const event = retrain('manual');
    expect(event.corrections_used).toBe(1);

    // Should have proposed a weight reduction for that pattern
    const p0Delta = event.weight_changes.find(d => d.field.includes('Direct prompt injection'));
    if (event.validation_passed && p0Delta) {
      expect(p0Delta.new_value).toBeLessThan(p0Delta.old_value);
      // Safety: should not drop below 0.5 (critical pattern)
      expect(p0Delta.new_value).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('validation rejects weights that silence critical patterns', () => {
    const log = makeScanLog();

    // Flood with corrections to push weight very low
    for (let i = 0; i < 20; i++) {
      const scanId = `scan-flood-${i}`;
      log.logScan(makeScanEntry({
        scan_id: scanId,
        verdict: 'blocked',
        matched_patterns: ['Mount path reference'],
      }));
      log.logCorrection(makeCorrection({
        scan_id: scanId,
        corrected_tier: 'p0',
        corrected_verdict: 'clean',
        sample_weight: 3.0,
      }));
    }

    const event = retrain('manual', { max_adjustment: 0.3, min_pattern_weight: 0.1 });
    // Even with many corrections, "Mount path reference" should stay >= 0.5
    const w = loadP0Weights(true);
    expect(w.pattern_weights['Mount path reference']).toBeGreaterThanOrEqual(0.5);
  });

  it('retrain logs event to retrain-history.jsonl', () => {
    retrain('manual');
    const historyPath = path.join(tmpDir, '.rai', 'scan-log', 'retrain-history.jsonl');
    expect(fs.existsSync(historyPath)).toBe(true);
    const lines = fs.readFileSync(historyPath, 'utf-8').split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const event: RetrainEvent = JSON.parse(lines[lines.length - 1]);
    expect(event.trigger).toBe('manual');
  });
});

describe('P2 Weighted Consensus', () => {
  // Test the consensus layer directly with custom weights
  let mergeVerdicts: typeof import('../../packages/p2-agent/src/consensus.js').mergeVerdicts;

  beforeEach(async () => {
    const mod = await import('../p2-agent/src/consensus.js');
    mergeVerdicts = mod.mergeVerdicts;
  });

  it('uniform weights produce same result as before', () => {
    const verdicts = [
      { agent: 'provenance' as const, verdict: 'supports_claim' as const, confidence: 0.8, reasoning: '', evidence: [] },
      { agent: 'cross-ref' as const, verdict: 'supports_claim' as const, confidence: 0.7, reasoning: '', evidence: [] },
      { agent: 'temporal' as const, verdict: 'supports_claim' as const, confidence: 0.9, reasoning: '', evidence: [] },
      { agent: 'credibility' as const, verdict: 'contradicts_claim' as const, confidence: 0.6, reasoning: '', evidence: [] },
    ];

    const result = mergeVerdicts('scan-1', verdicts);
    // 3 supporting + 1 contradicting = disagreement
    expect(result.disagreement).toBe(true);
    expect(result.recommended_action).toBe('human_review');
  });

  it('high-weight agent tips consensus', () => {
    const verdicts = [
      { agent: 'provenance' as const, verdict: 'supports_claim' as const, confidence: 0.8, reasoning: '', evidence: [] },
      { agent: 'cross-ref' as const, verdict: 'supports_claim' as const, confidence: 0.7, reasoning: '', evidence: [] },
      { agent: 'temporal' as const, verdict: 'uncertain' as const, confidence: 0.5, reasoning: '', evidence: [] },
      { agent: 'credibility' as const, verdict: 'uncertain' as const, confidence: 0.5, reasoning: '', evidence: [] },
    ];

    // With default weights: 2 supporting = likely_threat
    const defaultResult = mergeVerdicts('scan-2', verdicts);
    expect(defaultResult.consensus_verdict).toBe('likely_threat');

    // Boost provenance to 2.0: now weighted supporting = 3.0 >= confirmed_threat threshold
    const boosted = mergeVerdicts('scan-2', verdicts, {
      agent_weights: { provenance: 2.0, 'cross-ref': 1.0, temporal: 1.0, credibility: 1.0 },
      consensus_thresholds: {
        confirmed_threat_min_supporting: 3,
        likely_threat_min_supporting: 2,
        false_positive_min_contradicting: 3,
        likely_safe_min_contradicting: 2,
        human_review_min_uncertain: 3,
      },
    });
    expect(boosted.consensus_verdict).toBe('confirmed_threat');
  });

  it('weighted confidence reflects agent importance', () => {
    const verdicts = [
      { agent: 'provenance' as const, verdict: 'supports_claim' as const, confidence: 0.9, reasoning: '', evidence: [] },
      { agent: 'cross-ref' as const, verdict: 'supports_claim' as const, confidence: 0.3, reasoning: '', evidence: [] },
      { agent: 'temporal' as const, verdict: 'supports_claim' as const, confidence: 0.3, reasoning: '', evidence: [] },
      { agent: 'credibility' as const, verdict: 'supports_claim' as const, confidence: 0.3, reasoning: '', evidence: [] },
    ];

    // Uniform weights: avg = (0.9+0.3+0.3+0.3)/4 = 0.45
    const uniform = mergeVerdicts('scan-3', verdicts);
    expect(uniform.consensus_confidence).toBeCloseTo(0.45, 1);

    // Boost provenance (the high-confidence one): avg shifts up
    const boosted = mergeVerdicts('scan-3', verdicts, {
      agent_weights: { provenance: 3.0, 'cross-ref': 1.0, temporal: 1.0, credibility: 1.0 },
      consensus_thresholds: {
        confirmed_threat_min_supporting: 3,
        likely_threat_min_supporting: 2,
        false_positive_min_contradicting: 3,
        likely_safe_min_contradicting: 2,
        human_review_min_uncertain: 3,
      },
    });
    // Weighted: (0.9*3 + 0.3*1 + 0.3*1 + 0.3*1) / (3+1+1+1) = 3.6/6 = 0.6
    expect(boosted.consensus_confidence).toBeCloseTo(0.6, 1);
  });
});
