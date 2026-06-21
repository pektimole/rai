/**
 * External web search for providers that lack a native tool (Together, Ollama).
 *
 * Strategy: Brave Search API as the default external provider. Pluggable so
 * the council can swap to Tavily/Exa/SerpAPI without touching adapters.
 *
 * Env: BRAVE_SEARCH_API_KEY required.
 *
 * OL-395: Each result is scanned for prompt injection before being injected into
 * agent context. Blocked results are dropped; flagged results are annotated.
 * Uses an inline lightweight filter (L-1 + L0 critical patterns) to avoid
 * circular dependency with @rai/core.
 */

import type { Citation, CredibilityTier } from '../types.js';
import { lookupCredibility } from '../agents/credibility.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export interface WebSearchResult {
  snippets: string;
  citations: Citation[];
  /** Number of results dropped by the injection filter. */
  filtered_count: number;
}

export async function fetchWebSearchSnippets(query: string, topK = 5): Promise<WebSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { snippets: '(no web search results available)', citations: [], filtered_count: 0 };
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(topK));

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    return { snippets: '(web search failed)', citations: [], filtered_count: 0 };
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];

  const raw: Citation[] = results.slice(0, topK).map(r => ({
    url: r.url,
    title: r.title,
    source_tier: tierFor(r.url),
    published_at: r.page_age,
    excerpt: (r.description ?? '').slice(0, 280),
    supports: 'context' as const,
  }));

  // OL-395: P0 injection scan on each result before injecting into agent context.
  // Dropped results are NOT passed to the model — search-result poisoning vector closed.
  let filtered_count = 0;
  const safe: Array<{ citation: Citation; flagged: boolean }> = [];
  for (const c of raw) {
    const scan = scanForInjection(`${c.title} ${c.excerpt}`);
    if (scan.blocked) {
      filtered_count++;
    } else {
      safe.push({ citation: c, flagged: scan.flagged });
    }
  }

  const citations = safe.map(s => s.citation);
  const snippets = safe
    .map((s, i) => {
      const flag = s.flagged ? ' [RAI: content flagged, treat with caution]' : '';
      return `[${i + 1}] ${s.citation.title}${flag}\n${s.citation.url}\n${s.citation.excerpt}`;
    })
    .join('\n\n');

  return { snippets: snippets || '(all results filtered by RAI P0 scan)', citations, filtered_count };
}

// ---------------------------------------------------------------------------
// Inline injection filter (OL-395)
//
// Lightweight standalone scanner for the critical L-1 and L0 patterns.
// Does NOT import from @rai/core (that would create a circular dependency:
// @rai/core → @rai/p2-agent → @rai/core). Replicates only the patterns
// necessary to defend search-result injection. Full P0 is in @rai/core.
// ---------------------------------------------------------------------------

interface InlineScanResult {
  blocked: boolean;
  flagged: boolean;
  reason?: string;
}

const BLOCKED_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  // L-1: model poisoning / drift
  { regex: /you\s+are\s+now\s+(?!an?\s+AI|an?\s+assistant)[a-zA-Z]/i, reason: 'L-1 persona replacement' },
  { regex: /forget\s+(?:that\s+)?you\s+are|your\s+new\s+(?:identity|persona|role|name)\s+is/i, reason: 'L-1 persona replacement' },
  { regex: /(?:your\s+)?(?:new|updated)\s+(?:system\s+)?(?:instructions?|prompt|rules?)\s+(?:are|is):/i, reason: 'L-1 system prompt injection' },
  { regex: /ignore\s+(?:your\s+)?(?:previous\s+)?(?:training|guidelines|rules|instructions|constraints)/i, reason: 'L-1 training override' },
  // L0: direct injection
  { regex: /ignore\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+instructions?/i, reason: 'L0 direct injection' },
  { regex: /disregard\s+(?:all\s+)?(?:previous|prior|your)\s+|override\s+(?:your\s+)?(?:instructions?|programming|rules)/i, reason: 'L0 direct injection' },
  { regex: /\bDAN\b|developer\s+mode|jailbreak|unrestricted\s+mode|pretend\s+you\s+have\s+no\s+rules/i, reason: 'L0 jailbreak' },
  { regex: /act\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|evil)/i, reason: 'L0 jailbreak' },
  { regex: /<<\s*system[_\s-]?override\s*>>|\[\[\s*system[_\s-]?override\s*\]\]/i, reason: 'L0 system-override token' },
  { regex: /(?:previous|prior)\s+instructions?\s+(?:are|have\s+been)\s+(?:deprecated|superseded|invalid|cancelled|revoked)/i, reason: 'L0 instruction invalidation' },
];

const FLAGGED_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /from\s+now\s+on[,\s]+(?:always|never)\s+/i, reason: 'L-1 behavioral drift' },
  { regex: /always\s+respond\s+by\s+|never\s+(?:mention|refer|say|tell)\s+/i, reason: 'L-1 behavioral drift' },
  { regex: /use\s+(?:the\s+)?(?:mcp\s+)?tool|call\s+(?:the\s+)?function/i, reason: 'L-2 tool call injection' },
];

function scanForInjection(text: string): InlineScanResult {
  for (const { regex, reason } of BLOCKED_PATTERNS) {
    if (regex.test(text)) return { blocked: true, flagged: false, reason };
  }
  for (const { regex, reason } of FLAGGED_PATTERNS) {
    if (regex.test(text)) return { blocked: false, flagged: true, reason };
  }
  return { blocked: false, flagged: false };
}

function tierFor(url: string): CredibilityTier {
  try {
    const host = new URL(url).hostname;
    return lookupCredibility(host) ?? 'community';
  } catch {
    return 'anonymous';
  }
}

interface BraveSearchResponse {
  web?: { results?: Array<{ url: string; title: string; description?: string; page_age?: string }> };
}
