/**
 * Agent D: Source Credibility
 * "What is the track record of this source?
 *  Official disclosure channel vs social media vs anonymous?"
 */

import type { AgentVerdict, CredibilityTier, P2Input, SourceCredibility } from '../types.js';

export const CREDIBILITY_SEED: SourceCredibility[] = [
  { url_pattern: 'github.com/*/security', tier: 'official', weight: 0.9 },
  { url_pattern: 'cve.org', tier: 'official', weight: 0.9 },
  { url_pattern: 'nvd.nist.gov', tier: 'official', weight: 0.9 },
  { url_pattern: 'sec.gov', tier: 'official', weight: 0.9 },
  { url_pattern: 'venturebeat.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'techcrunch.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'fortune.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'arstechnica.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'news.ycombinator.com', tier: 'community', weight: 0.5 },
  { url_pattern: 'reddit.com', tier: 'community', weight: 0.5 },
  { url_pattern: 'dev.to', tier: 'community', weight: 0.5 },
  { url_pattern: 'twitter.com', tier: 'social', weight: 0.3 },
  { url_pattern: 'x.com', tier: 'social', weight: 0.3 },
  { url_pattern: 'pastebin.com', tier: 'anonymous', weight: 0.1 },
];

export const CREDIBILITY_PROMPT = `You are a source credibility agent. Your job is to assess the trustworthiness of the source making a claim.

Analyze:
1. What is the track record of this source?
2. Is this an official disclosure channel, established media, community forum, social media, or anonymous?
3. Does the source have domain expertise relevant to the claim?
4. Has this source been reliable or unreliable in the past?

Return JSON only:
{
  "verdict": "supports_claim" | "contradicts_claim" | "uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "one paragraph",
  "evidence": ["bullet point observations"]
}`;

export function lookupCredibility(url: string): CredibilityTier {
  for (const entry of CREDIBILITY_SEED) {
    if (url.includes(entry.url_pattern)) return entry.tier;
  }
  return 'anonymous';
}

export async function runCredibilityAgent(
  _input: P2Input,
  _apiKey: string,
): Promise<AgentVerdict> {
  return {
    agent: 'credibility',
    verdict: 'uncertain',
    confidence: 0,
    reasoning: 'Not yet implemented',
    evidence: [],
  };
}
