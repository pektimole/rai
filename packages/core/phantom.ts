/**
 * phantom.ts — RAI Phantom: adaptive threat model refinement
 *
 * 6-step self-evolution pipeline (same pattern as OL-104 ambient feed):
 *   1. Observe  — read scan log + correction log
 *   2. Critique — identify patterns in corrections (which weights are wrong?)
 *   3. Generate — propose weight adjustments
 *   4. Validate — sanity-check proposed weights (no dangerous relaxation)
 *   5. Apply    — write new weights to JSON files
 *   6. Log      — record retrain event for audit trail
 *
 * Correction signals:
 *   - User override: user dismisses a verdict or escalates a clean scan
 *   - Cross-tier: P1 contradicts P0, or P2 contradicts P1
 *
 * Retrain triggers (same as OL-104):
 *   - >= 10 corrections since last retrain, OR
 *   - >= 7 days since last retrain
 *   - Manual: explicit CLI invocation
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScanLog, getDefaultScanLog } from './scan-log.js';
import type { ScanLogEntry, CorrectionEntry } from './scan-log.js';
import {
  loadP0Weights, loadP1Weights, loadP2Weights,
  saveP0Weights, saveP1Weights, saveP2Weights,
  type P0Weights, type P1Weights, type P2Weights,
} from './threat-weights.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrainEvent {
  timestamp: string;
  trigger: 'threshold' | 'scheduled' | 'manual';
  corrections_used: number;
  weight_changes: WeightDelta[];
  validation_passed: boolean;
}

export interface WeightDelta {
  tier: 'p0' | 'p1' | 'p2';
  field: string;
  old_value: number;
  new_value: number;
  reason: string;
}

export interface PhantomConfig {
  /** Min corrections before retrain triggers. Default: 10. */
  min_corrections: number;
  /** Max days between retrains. Default: 7. */
  max_days_between_retrains: number;
  /** Max adjustment per retrain cycle (prevents wild swings). Default: 0.3. */
  max_adjustment: number;
  /** Floor for pattern weights (never fully suppress a pattern). Default: 0.1. */
  min_pattern_weight: number;
  /** Ceiling for pattern weights. Default: 3.0. */
  max_pattern_weight: number;
}

const DEFAULT_CONFIG: PhantomConfig = {
  min_corrections: 10,
  max_days_between_retrains: 7,
  max_adjustment: 0.3,
  min_pattern_weight: 0.1,
  max_pattern_weight: 3.0,
};

// ---------------------------------------------------------------------------
// Retrain history
// ---------------------------------------------------------------------------

function retrainLogPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.rai', 'scan-log', 'retrain-history.jsonl');
}

function readRetrainHistory(): RetrainEvent[] {
  const p = retrainLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as RetrainEvent);
}

function appendRetrainEvent(event: RetrainEvent): void {
  const p = retrainLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(event) + '\n');
}

// ---------------------------------------------------------------------------
// Step 1: Observe — gather training data
// ---------------------------------------------------------------------------

interface TrainingData {
  scans: ScanLogEntry[];
  corrections: CorrectionEntry[];
  lastRetrain: RetrainEvent | null;
}

function observe(scanLog: ScanLog): TrainingData {
  const history = readRetrainHistory();
  const lastRetrain = history.length > 0 ? history[history.length - 1] : null;

  const allScans = scanLog.readScans();
  const allCorrections = scanLog.readCorrections();

  // Only use corrections since last retrain
  const since = lastRetrain?.timestamp ?? '1970-01-01T00:00:00Z';
  const corrections = allCorrections.filter(c => c.timestamp > since);

  return { scans: allScans, corrections, lastRetrain };
}

// ---------------------------------------------------------------------------
// Step 2: Critique — identify which weights need adjustment
// ---------------------------------------------------------------------------

interface Critique {
  p0_pattern_adjustments: Map<string, { direction: 'up' | 'down'; count: number; total_weight: number }>;
  p1_escalation_adjustment: number; // positive = raise threshold, negative = lower
  p2_agent_adjustments: Map<string, number>; // positive = increase agent weight
}

function critique(data: TrainingData): Critique {
  const result: Critique = {
    p0_pattern_adjustments: new Map(),
    p1_escalation_adjustment: 0,
    p2_agent_adjustments: new Map(),
  };

  for (const correction of data.corrections) {
    const scan = data.scans.find(s => s.scan_id === correction.scan_id);
    if (!scan) continue;

    const w = correction.sample_weight;

    if (correction.corrected_tier === 'p0' && scan.matched_patterns) {
      // P0 correction: if verdict was too aggressive, reduce pattern weights
      const isOverblock = scan.verdict === 'blocked' && correction.corrected_verdict === 'clean';
      const isUnderflag = scan.verdict === 'clean' && correction.corrected_verdict !== 'clean';

      for (const pattern of scan.matched_patterns) {
        const existing = result.p0_pattern_adjustments.get(pattern) ?? { direction: 'down', count: 0, total_weight: 0 };
        if (isOverblock) {
          existing.direction = 'down';
          existing.count += 1;
          existing.total_weight += w;
        } else if (isUnderflag) {
          existing.direction = 'up';
          existing.count += 1;
          existing.total_weight += w;
        }
        result.p0_pattern_adjustments.set(pattern, existing);
      }
    }

    if (correction.corrected_tier === 'p1') {
      // P1 correction: if P1 missed something P0 caught, lower escalation threshold
      if (correction.correction_source === 'cross_tier' && correction.contradicting_tier === 'p0') {
        result.p1_escalation_adjustment -= 0.02 * w;
      }
      // If P1 was too aggressive (user said clean), raise threshold slightly
      if (correction.correction_source === 'user_override' && correction.corrected_verdict === 'clean') {
        result.p1_escalation_adjustment += 0.01 * w;
      }
    }

    if (correction.corrected_tier === 'p2' && scan.agent_verdicts) {
      // P2 correction: adjust weight of agents that were wrong
      for (const av of scan.agent_verdicts) {
        const agentWasCorrect = av.verdict === 'supports_claim' && correction.corrected_verdict !== 'clean';
        const agentWasWrong = av.verdict === 'supports_claim' && correction.corrected_verdict === 'clean';

        const current = result.p2_agent_adjustments.get(av.agent) ?? 0;
        if (agentWasCorrect) {
          result.p2_agent_adjustments.set(av.agent, current + 0.05 * w);
        } else if (agentWasWrong) {
          result.p2_agent_adjustments.set(av.agent, current - 0.05 * w);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: Generate — propose new weights
// ---------------------------------------------------------------------------

interface WeightProposal {
  p0: P0Weights;
  p1: P1Weights;
  p2: P2Weights;
  deltas: WeightDelta[];
}

function generate(crit: Critique, config: PhantomConfig): WeightProposal {
  const p0 = loadP0Weights(true);
  const p1 = loadP1Weights(true);
  const p2 = loadP2Weights(true);
  const deltas: WeightDelta[] = [];

  // P0 pattern weight adjustments
  for (const [pattern, adj] of crit.p0_pattern_adjustments) {
    const old = p0.pattern_weights[pattern] ?? 1.0;
    const magnitude = Math.min(adj.total_weight * 0.05, config.max_adjustment);
    const delta = adj.direction === 'down' ? -magnitude : magnitude;
    const clamped = Math.max(config.min_pattern_weight, Math.min(config.max_pattern_weight, old + delta));
    if (clamped !== old) {
      p0.pattern_weights[pattern] = clamped;
      deltas.push({
        tier: 'p0', field: `pattern_weights.${pattern}`,
        old_value: old, new_value: clamped,
        reason: `${adj.count} corrections (${adj.direction}), weight ${adj.total_weight.toFixed(1)}`,
      });
    }
  }

  // P1 escalation threshold
  if (crit.p1_escalation_adjustment !== 0) {
    const old = p1.escalation_threshold;
    const adj = Math.max(-config.max_adjustment, Math.min(config.max_adjustment, crit.p1_escalation_adjustment));
    const clamped = Math.max(0.3, Math.min(0.9, old + adj));
    if (clamped !== old) {
      p1.escalation_threshold = clamped;
      deltas.push({
        tier: 'p1', field: 'escalation_threshold',
        old_value: old, new_value: clamped,
        reason: `net adjustment ${adj > 0 ? '+' : ''}${adj.toFixed(3)}`,
      });
    }
  }

  // P2 agent weights
  for (const [agent, adj] of crit.p2_agent_adjustments) {
    const old = (p2.agent_weights as unknown as Record<string, number>)[agent] ?? 1.0;
    const clampedAdj = Math.max(-config.max_adjustment, Math.min(config.max_adjustment, adj));
    const newVal = Math.max(0.2, Math.min(3.0, old + clampedAdj));
    if (newVal !== old) {
      (p2.agent_weights as unknown as Record<string, number>)[agent] = newVal;
      deltas.push({
        tier: 'p2', field: `agent_weights.${agent}`,
        old_value: old, new_value: newVal,
        reason: `net adjustment ${clampedAdj > 0 ? '+' : ''}${clampedAdj.toFixed(3)}`,
      });
    }
  }

  return { p0, p1, p2, deltas };
}

// ---------------------------------------------------------------------------
// Step 4: Validate — safety checks
// ---------------------------------------------------------------------------

function validate(proposal: WeightProposal, config: PhantomConfig): boolean {
  // Rule 1: Never reduce L-2/L-1 critical pattern weights below 0.5
  const criticalPatterns = [
    'Mount path reference',
    'Context file reference',
    'Credential / data exfiltration attempt',
    'Context file manipulation',
    'Persona replacement',
    'System prompt injection',
  ];
  for (const p of criticalPatterns) {
    if ((proposal.p0.pattern_weights[p] ?? 1.0) < 0.5) return false;
  }

  // Rule 2: Escalation threshold must stay in sane range
  if (proposal.p1.escalation_threshold < 0.3 || proposal.p1.escalation_threshold > 0.9) return false;

  // Rule 3: No agent weight below 0.2 (no agent fully silenced)
  for (const w of Object.values(proposal.p2.agent_weights)) {
    if (w < 0.2) return false;
  }

  // Rule 4: Max deltas per cycle (prevent runaway)
  const bigDeltas = proposal.deltas.filter(d => Math.abs(d.new_value - d.old_value) > config.max_adjustment);
  if (bigDeltas.length > 0) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Step 5: Apply — write weights to disk
// ---------------------------------------------------------------------------

function apply(proposal: WeightProposal): void {
  if (proposal.deltas.some(d => d.tier === 'p0')) saveP0Weights(proposal.p0);
  if (proposal.deltas.some(d => d.tier === 'p1')) saveP1Weights(proposal.p1);
  if (proposal.deltas.some(d => d.tier === 'p2')) saveP2Weights(proposal.p2);
}

// ---------------------------------------------------------------------------
// Step 6: Log — record retrain event
// ---------------------------------------------------------------------------

function logRetrain(trigger: RetrainEvent['trigger'], corrections: number, deltas: WeightDelta[], passed: boolean): RetrainEvent {
  const event: RetrainEvent = {
    timestamp: new Date().toISOString(),
    trigger,
    corrections_used: corrections,
    weight_changes: deltas,
    validation_passed: passed,
  };
  appendRetrainEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if retrain should trigger based on correction count and time elapsed.
 */
export function shouldRetrain(config?: Partial<PhantomConfig>): boolean {
  const c = { ...DEFAULT_CONFIG, ...config };
  const scanLog = getDefaultScanLog();
  const history = readRetrainHistory();
  const lastRetrain = history.length > 0 ? history[history.length - 1] : null;

  const since = lastRetrain?.timestamp ?? '1970-01-01T00:00:00Z';
  const corrections = scanLog.readCorrections().filter(cr => cr.timestamp > since);

  if (corrections.length >= c.min_corrections) return true;

  if (lastRetrain) {
    const daysSince = (Date.now() - new Date(lastRetrain.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= c.max_days_between_retrains && corrections.length > 0) return true;
  }

  return false;
}

/**
 * Run the full 6-step Phantom retrain pipeline.
 * Returns the retrain event (including whether validation passed).
 */
export function retrain(
  trigger: RetrainEvent['trigger'] = 'manual',
  config?: Partial<PhantomConfig>,
): RetrainEvent {
  const c = { ...DEFAULT_CONFIG, ...config };
  const scanLog = getDefaultScanLog();

  // 1. Observe
  const data = observe(scanLog);
  if (data.corrections.length === 0) {
    return logRetrain(trigger, 0, [], true);
  }

  // 2. Critique
  const crit = critique(data);

  // 3. Generate
  const proposal = generate(crit, c);
  if (proposal.deltas.length === 0) {
    return logRetrain(trigger, data.corrections.length, [], true);
  }

  // 4. Validate
  const passed = validate(proposal, c);

  // 5. Apply (only if validation passes)
  if (passed) {
    apply(proposal);
  }

  // 6. Log
  return logRetrain(trigger, data.corrections.length, proposal.deltas, passed);
}

/**
 * Read retrain history for dashboard display.
 */
export function getRetrainHistory(): RetrainEvent[] {
  return readRetrainHistory();
}

export { DEFAULT_CONFIG as PHANTOM_DEFAULT_CONFIG };
