/**
 * P2 Consensus Layer
 * Merges independent agent verdicts into a single P2 result.
 * Disagreement between agents triggers human_review recommendation.
 *
 * Supports adaptive agent weights from Phantom retrain loop:
 * - Each agent has a weight (default 1.0) that scales its vote
 * - Consensus thresholds are configurable via p2-weights.json
 */

import type { AgentVerdict, P2Result, P2Weights } from './types.js';

/** Default weights used when no external config is provided. */
const DEFAULT_WEIGHTS: P2Weights = {
  agent_weights: { provenance: 1.0, 'cross-ref': 1.0, temporal: 1.0, credibility: 1.0 },
  consensus_thresholds: {
    confirmed_threat_min_supporting: 3,
    likely_threat_min_supporting: 2,
    false_positive_min_contradicting: 3,
    likely_safe_min_contradicting: 2,
    human_review_min_uncertain: 3,
  },
};

/**
 * Compute weighted vote count for a verdict category.
 */
function weightedCount(
  verdicts: AgentVerdict[],
  category: AgentVerdict['verdict'],
  agentWeights: Record<string, number>,
): number {
  return verdicts
    .filter(v => v.verdict === category)
    .reduce((sum, v) => sum + (agentWeights[v.agent] ?? 1.0), 0);
}

export function mergeVerdicts(
  scanId: string,
  verdicts: AgentVerdict[],
  weights?: P2Weights,
): P2Result {
  const w = weights ?? DEFAULT_WEIGHTS;
  const aw = w.agent_weights as Record<string, number>;
  const t = w.consensus_thresholds;

  const supportingW = weightedCount(verdicts, 'supports_claim', aw);
  const contradictingW = weightedCount(verdicts, 'contradicts_claim', aw);
  const uncertainW = weightedCount(verdicts, 'uncertain', aw);

  // Weighted confidence
  const totalWeight = verdicts.reduce((sum, v) => sum + (aw[v.agent] ?? 1.0), 0);
  const avgConfidence = totalWeight > 0
    ? verdicts.reduce((sum, v) => sum + v.confidence * (aw[v.agent] ?? 1.0), 0) / totalWeight
    : 0;

  const disagreement = supportingW > 0 && contradictingW > 0;

  let consensusVerdict: P2Result['consensus_verdict'];
  let recommendedAction: P2Result['recommended_action'];

  if (disagreement) {
    consensusVerdict = 'uncertain';
    recommendedAction = 'human_review';
  } else if (supportingW >= t.confirmed_threat_min_supporting) {
    consensusVerdict = 'confirmed_threat';
    recommendedAction = 'block';
  } else if (supportingW >= t.likely_threat_min_supporting) {
    consensusVerdict = 'likely_threat';
    recommendedAction = 'warn';
  } else if (contradictingW >= t.false_positive_min_contradicting) {
    consensusVerdict = 'false_positive';
    recommendedAction = 'pass';
  } else if (contradictingW >= t.likely_safe_min_contradicting) {
    consensusVerdict = 'likely_safe';
    recommendedAction = 'pass';
  } else {
    consensusVerdict = 'uncertain';
    recommendedAction = uncertainW >= t.human_review_min_uncertain ? 'human_review' : 'warn';
  }

  const explanation = disagreement
    ? `Agents disagree: ${supportingW.toFixed(1)} weighted support, ${contradictingW.toFixed(1)} weighted contradict. Human review recommended.`
    : `Weighted votes: ${supportingW.toFixed(1)} support, ${contradictingW.toFixed(1)} contradict, ${uncertainW.toFixed(1)} uncertain. Confidence: ${(avgConfidence * 100).toFixed(0)}%.`;

  return {
    scan_id: scanId,
    consensus_verdict: consensusVerdict,
    consensus_confidence: avgConfidence,
    agent_verdicts: verdicts,
    disagreement,
    explanation,
    recommended_action: recommendedAction,
  };
}
