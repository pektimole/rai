/**
 * Agent B: Cross-Reference Scorer
 * "Do multiple independent sources confirm/deny independently?
 *  Are sources citing each other or independently reporting?"
 */

import type { AgentVerdict, P2Input } from '../types.js';

export const CROSS_REF_PROMPT = `You are a cross-reference verification agent. Your job is to assess whether a claim is independently corroborated.

Analyze:
1. Do multiple independent sources confirm or deny this claim?
2. Are the sources citing each other (echo chamber) or reporting independently?
3. Is there a single original source that all others trace back to?
4. Do any authoritative sources directly contradict the claim?

Return JSON only:
{
  "verdict": "supports_claim" | "contradicts_claim" | "uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "one paragraph",
  "evidence": ["bullet point observations"]
}`;

export async function runCrossRefAgent(
  _input: P2Input,
  _apiKey: string,
): Promise<AgentVerdict> {
  return {
    agent: 'cross-ref',
    verdict: 'uncertain',
    confidence: 0,
    reasoning: 'Not yet implemented',
    evidence: [],
  };
}
