/**
 * Agent D: Source Credibility
 * "What is the track record of this source?
 *  Official disclosure channel vs social media vs anonymous?"
 */

import type { AgentVerdict, CredibilityTier, P2Input, SourceCredibility } from '../types.js';
import { callAgent } from './call-agent.js';

export const CREDIBILITY_SEED: SourceCredibility[] = [
  // Official: government, standards bodies, vendor security channels
  { url_pattern: 'cve.org', tier: 'official', weight: 0.9 },
  { url_pattern: 'nvd.nist.gov', tier: 'official', weight: 0.9 },
  { url_pattern: 'cisa.gov', tier: 'official', weight: 0.9 },
  { url_pattern: 'sec.gov', tier: 'official', weight: 0.9 },
  { url_pattern: 'github.com/advisories', tier: 'official', weight: 0.9 },
  { url_pattern: 'github.com/security', tier: 'official', weight: 0.9 },
  { url_pattern: 'oracle.com', tier: 'official', weight: 0.9 },
  { url_pattern: 'microsoft.com/security', tier: 'official', weight: 0.9 },
  { url_pattern: 'support.microsoft.com', tier: 'official', weight: 0.9 },
  { url_pattern: 'msrc.microsoft.com', tier: 'official', weight: 0.9 },
  { url_pattern: 'google.com/intl/en/about/products', tier: 'official', weight: 0.9 },
  { url_pattern: 'cloud.google.com/support/bulletins', tier: 'official', weight: 0.9 },
  { url_pattern: 'aws.amazon.com/security/security-bulletins', tier: 'official', weight: 0.9 },
  { url_pattern: 'logging.apache.org', tier: 'official', weight: 0.9 },
  { url_pattern: 'apache.org', tier: 'official', weight: 0.85 },

  // Established: security research firms, major tech journalism
  { url_pattern: 'qualys.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'tenable.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'rapid7.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'crowdstrike.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'huntress.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'snyk.io', tier: 'established', weight: 0.75 },
  { url_pattern: 'checkmarx.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'bleepingcomputer.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'therecord.media', tier: 'established', weight: 0.7 },
  { url_pattern: 'krebsonsecurity.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'wired.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'venturebeat.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'techcrunch.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'fortune.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'arstechnica.com', tier: 'established', weight: 0.7 },
  { url_pattern: 'reuters.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'apnews.com', tier: 'established', weight: 0.75 },
  { url_pattern: 'en.wikipedia.org', tier: 'established', weight: 0.65 },

  // Community: technical forums, aggregators
  { url_pattern: 'news.ycombinator.com', tier: 'community', weight: 0.5 },
  { url_pattern: 'reddit.com', tier: 'community', weight: 0.5 },
  { url_pattern: 'dev.to', tier: 'community', weight: 0.5 },
  { url_pattern: 'stackoverflow.com', tier: 'community', weight: 0.5 },
  { url_pattern: 'medium.com', tier: 'community', weight: 0.45 },

  // Social
  { url_pattern: 'twitter.com', tier: 'social', weight: 0.3 },
  { url_pattern: 'x.com', tier: 'social', weight: 0.3 },
  { url_pattern: 'linkedin.com', tier: 'social', weight: 0.3 },
  { url_pattern: 'telegram.org', tier: 'social', weight: 0.25 },

  // Anonymous
  { url_pattern: 'pastebin.com', tier: 'anonymous', weight: 0.1 },
  { url_pattern: 'ghostbin.com', tier: 'anonymous', weight: 0.1 },
];

export const CREDIBILITY_PROMPT = `You are a source credibility agent. Your job is to assess the trustworthiness of the source making a claim.

You will receive a claim and its source. You also have access to a source credibility index:
- Official (weight 0.9): company blogs, CVE databases, SEC filings, GitHub security advisories
- Established media (weight 0.7): VentureBeat, TechCrunch, Fortune, Ars Technica
- Community (weight 0.5): HackerNews, Reddit, dev.to
- Social (weight 0.3): Twitter/X, Telegram
- Anonymous (weight 0.1): Pastebin, anonymous forums

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
  input: P2Input,
  apiKey: string,
): Promise<AgentVerdict> {
  // Enrich the prompt with credibility lookup if source URL is available
  let enrichedPrompt = CREDIBILITY_PROMPT;
  if (input.source_url) {
    const tier = lookupCredibility(input.source_url);
    const entry = CREDIBILITY_SEED.find(e => input.source_url!.includes(e.url_pattern));
    enrichedPrompt += `\n\nSource credibility lookup result: tier="${tier}", weight=${entry?.weight ?? 0.1}`;
  }
  return callAgent('credibility', enrichedPrompt, input, apiKey);
}
