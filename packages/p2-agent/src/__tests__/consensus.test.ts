import { describe, it, expect } from 'vitest';
import { mergeVerdicts } from '../consensus.js';
import type { AgentVerdict } from '../types.js';

function verdict(
  agent: AgentVerdict['agent'],
  v: AgentVerdict['verdict'],
  confidence: number,
): AgentVerdict {
  return { agent, verdict: v, confidence, reasoning: 'test', evidence: [] };
}

describe('mergeVerdicts', () => {
  it('returns confirmed_threat when 3+ agents support', () => {
    const result = mergeVerdicts('scan-1', [
      verdict('provenance', 'supports_claim', 0.9),
      verdict('cross-ref', 'supports_claim', 0.8),
      verdict('temporal', 'supports_claim', 0.7),
      verdict('credibility', 'uncertain', 0.5),
    ]);
    expect(result.consensus_verdict).toBe('confirmed_threat');
    expect(result.recommended_action).toBe('block');
    expect(result.disagreement).toBe(false);
  });

  it('returns likely_threat when 2 agents support', () => {
    const result = mergeVerdicts('scan-2', [
      verdict('provenance', 'supports_claim', 0.8),
      verdict('cross-ref', 'supports_claim', 0.7),
      verdict('temporal', 'uncertain', 0.4),
      verdict('credibility', 'uncertain', 0.3),
    ]);
    expect(result.consensus_verdict).toBe('likely_threat');
    expect(result.recommended_action).toBe('warn');
  });

  it('returns false_positive when 3+ agents contradict', () => {
    const result = mergeVerdicts('scan-3', [
      verdict('provenance', 'contradicts_claim', 0.9),
      verdict('cross-ref', 'contradicts_claim', 0.8),
      verdict('temporal', 'contradicts_claim', 0.7),
      verdict('credibility', 'uncertain', 0.5),
    ]);
    expect(result.consensus_verdict).toBe('false_positive');
    expect(result.recommended_action).toBe('pass');
  });

  it('returns likely_safe when 2 agents contradict', () => {
    const result = mergeVerdicts('scan-4', [
      verdict('provenance', 'contradicts_claim', 0.8),
      verdict('cross-ref', 'contradicts_claim', 0.7),
      verdict('temporal', 'uncertain', 0.4),
      verdict('credibility', 'uncertain', 0.3),
    ]);
    expect(result.consensus_verdict).toBe('likely_safe');
    expect(result.recommended_action).toBe('pass');
  });

  it('flags disagreement when agents split', () => {
    const result = mergeVerdicts('scan-5', [
      verdict('provenance', 'supports_claim', 0.9),
      verdict('cross-ref', 'contradicts_claim', 0.8),
      verdict('temporal', 'supports_claim', 0.7),
      verdict('credibility', 'contradicts_claim', 0.6),
    ]);
    expect(result.consensus_verdict).toBe('uncertain');
    expect(result.recommended_action).toBe('human_review');
    expect(result.disagreement).toBe(true);
  });

  it('returns human_review when 3+ uncertain', () => {
    const result = mergeVerdicts('scan-6', [
      verdict('provenance', 'uncertain', 0.3),
      verdict('cross-ref', 'uncertain', 0.2),
      verdict('temporal', 'uncertain', 0.4),
      verdict('credibility', 'uncertain', 0.3),
    ]);
    expect(result.consensus_verdict).toBe('uncertain');
    expect(result.recommended_action).toBe('human_review');
  });

  it('calculates average confidence', () => {
    const result = mergeVerdicts('scan-7', [
      verdict('provenance', 'supports_claim', 0.8),
      verdict('cross-ref', 'supports_claim', 0.6),
      verdict('temporal', 'supports_claim', 1.0),
      verdict('credibility', 'supports_claim', 0.6),
    ]);
    expect(result.consensus_confidence).toBe(0.75);
  });

  it('preserves all agent verdicts in result', () => {
    const verdicts = [
      verdict('provenance', 'supports_claim', 0.9),
      verdict('cross-ref', 'supports_claim', 0.8),
      verdict('temporal', 'supports_claim', 0.7),
      verdict('credibility', 'supports_claim', 0.6),
    ];
    const result = mergeVerdicts('scan-8', verdicts);
    expect(result.agent_verdicts).toHaveLength(4);
    expect(result.scan_id).toBe('scan-8');
  });
});
