/**
 * P2 Consensus Layer
 * Merges independent agent verdicts into a single P2 result.
 * Disagreement between agents triggers human_review recommendation.
 */

import type { AgentVerdict, P2Result } from './types.js';

export function mergeVerdicts(
  scanId: string,
  verdicts: AgentVerdict[],
): P2Result {
  const supporting = verdicts.filter(v => v.verdict === 'supports_claim');
  const contradicting = verdicts.filter(v => v.verdict === 'contradicts_claim');
  const uncertain = verdicts.filter(v => v.verdict === 'uncertain');

  const avgConfidence = verdicts.reduce((sum, v) => sum + v.confidence, 0) / verdicts.length;
  const disagreement = supporting.length > 0 && contradicting.length > 0;

  let consensusVerdict: P2Result['consensus_verdict'];
  let recommendedAction: P2Result['recommended_action'];

  if (disagreement) {
    consensusVerdict = 'uncertain';
    recommendedAction = 'human_review';
  } else if (supporting.length >= 3) {
    consensusVerdict = 'confirmed_threat';
    recommendedAction = 'block';
  } else if (supporting.length >= 2) {
    consensusVerdict = 'likely_threat';
    recommendedAction = 'warn';
  } else if (contradicting.length >= 3) {
    consensusVerdict = 'false_positive';
    recommendedAction = 'pass';
  } else if (contradicting.length >= 2) {
    consensusVerdict = 'likely_safe';
    recommendedAction = 'pass';
  } else {
    consensusVerdict = 'uncertain';
    recommendedAction = uncertain.length >= 3 ? 'human_review' : 'warn';
  }

  const explanation = disagreement
    ? `Agents disagree: ${supporting.length} support threat, ${contradicting.length} contradict. Human review recommended.`
    : `${supporting.length} agents support, ${contradicting.length} contradict, ${uncertain.length} uncertain. Confidence: ${(avgConfidence * 100).toFixed(0)}%.`;

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
