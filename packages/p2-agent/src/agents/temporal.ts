/**
 * Agent C: Temporal Context
 * "Is timing suspicious? Does the counter-claim appear suspiciously fast?"
 */

import type { AgentVerdict, P2Input } from '../types.js';

export const TEMPORAL_PROMPT = `You are a temporal context agent. Your job is to assess whether the timing of a claim or counter-claim is suspicious.

Analyze:
1. Is the timing suspicious? (April 1 proximity, post-market hours, weekend dumps, etc.)
2. Does a counter-claim appear suspiciously fast after the original claim?
3. Is the timeline consistent with how legitimate disclosures or corrections typically unfold?
4. Are there temporal patterns that suggest coordinated disinformation?

Return JSON only:
{
  "verdict": "supports_claim" | "contradicts_claim" | "uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "one paragraph",
  "evidence": ["bullet point observations"]
}`;

export async function runTemporalAgent(
  _input: P2Input,
  _apiKey: string,
): Promise<AgentVerdict> {
  return {
    agent: 'temporal',
    verdict: 'uncertain',
    confidence: 0,
    reasoning: 'Not yet implemented',
    evidence: [],
  };
}
