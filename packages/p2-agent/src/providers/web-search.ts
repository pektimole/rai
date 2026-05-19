/**
 * External web search for providers that lack a native tool (Together, Ollama).
 *
 * Strategy: Brave Search API as the default external provider. Pluggable so
 * the council can swap to Tavily/Exa/SerpAPI without touching adapters.
 *
 * Env: BRAVE_SEARCH_API_KEY required.
 */

import type { Citation, CredibilityTier } from '../types.js';
import { lookupCredibility } from '../agents/credibility.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export interface WebSearchResult {
  snippets: string;
  citations: Citation[];
}

export async function fetchWebSearchSnippets(query: string, topK = 5): Promise<WebSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    // Fail soft: no search available, return empty snippets so the model can answer
    // with "no_signal" via the verdict schema. The merge layer downgrades to UNVERIFIED.
    return { snippets: '(no web search results available)', citations: [] };
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
    return { snippets: '(web search failed)', citations: [] };
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = data.web?.results ?? [];

  const citations: Citation[] = results.slice(0, topK).map(r => ({
    url: r.url,
    title: r.title,
    source_tier: tierFor(r.url),
    published_at: r.page_age,
    excerpt: (r.description ?? '').slice(0, 280),
    supports: 'context',
  }));

  const snippets = citations
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.url}\n${c.excerpt}`)
    .join('\n\n');

  return { snippets, citations };
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
