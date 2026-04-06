/**
 * Agent A: Provenance Check
 * "Did this claim come from official channels? When was it first published?
 *  How quickly did it circulate relative to the event?"
 */

import type { AgentVerdict, P2Input } from '../types.js';

export const PROVENANCE_PROMPT = `You are a provenance verification agent. Your job is to assess the origin and timing of a claim.

Analyze:
1. Did this claim originate from an official channel (company blog, CVE database, press release)?
2. When was it first published relative to the event it describes?
3. How quickly did counter-claims or corrections appear?
4. Is the publication timeline consistent with legitimate disclosure, or suspicious (too fast, too coordinated)?

Return JSON only:
{
  "verdict": "supports_claim" | "contradicts_claim" | "uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "one paragraph",
  "evidence": ["bullet point observations"]
}`;

export async function runProvenanceAgent(
  _input: P2Input,
  _apiKey: string,
): Promise<AgentVerdict> {
  // TODO: implement with Claude API call
  return {
    agent: 'provenance',
    verdict: 'uncertain',
    confidence: 0,
    reasoning: 'Not yet implemented',
    evidence: [],
  };
}
