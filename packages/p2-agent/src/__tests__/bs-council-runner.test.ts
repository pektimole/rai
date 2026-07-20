/**
 * BS Council runner — integration tests with mocked providers.
 *
 * Distinguishes from bs-council.test.ts (merge-only): exercises the actual
 * dispatch, parser, and Gate-1 wrapper paths end-to-end with stubbed adapters.
 *
 * Turnbull-flip is tested here at the RUNNER level: provider returns empty
 * grounding → runner must emit UNVERIFIED, never a false verdict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CouncilConfig } from '../types.js';
import type { ProviderCallInput } from '../providers/types.js';

// Mock the provider registry before importing the runner.
const callMock = vi.fn();
vi.mock('../providers/index.js', () => ({
  getProvider: () => ({
    name: 'mock',
    call: callMock,
    supportsWebSearch: () => true,
  }),
}));

import { runBSCouncil, runBSCouncilForScan } from '../bs-council-runner.js';

const CONFIG: CouncilConfig = {
  agents: {
    A: { provider: 'anthropic', model: 'mock-sonnet', web_search: true },
    B: { provider: 'together', model: 'mock-qwen-72b', web_search: true },
    C: { provider: 'anthropic', model: 'mock-haiku', web_search: false },
    D: { provider: 'ollama', model: 'mock-qwen-14b', web_search: false },
  },
  tier_overrides: {
    free: { A: null, B: null, C: null, D: null },
    pro: null,
    premium: 'use defaults',
  },
};

function p2Input(overrides: Partial<{ claim: string; scan_id: string; source_url: string }> = {}) {
  return {
    scan_id: overrides.scan_id ?? 'test-scan',
    claim: overrides.claim ?? 'CVE-2024-99999 affects 187 packages with CVSS 9.6',
    source_url: overrides.source_url,
    channel: 'browser',
    p1_verdict: 'flagged' as const,
    p1_confidence: 0.6,
    p1_threat_layers: [],
    timestamp: '2026-05-24T12:00:00Z',
  };
}

describe('runBSCouncil — provider dispatch', () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it('Turnbull-flip: empty grounding → UNVERIFIED, never a false verdict', async () => {
    callMock.mockImplementation(async ({ systemPrompt }) => {
      // All four providers return no_signal / unknown — simulates cold lookup.
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"unknown","reasoning":"no source"}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"no_signal","reasoning":"no anchor"}', citations: [] };
      }
      return { text: '{"verdict":"no_signal","reasoning":"thin","citation_indices":[]}', citations: [] };
    });

    const result = await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'pro',
      apiKeys: { anthropic: 'k', together: 'k' },
    });

    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.verdict).not.toBe('CONFIRMED');
    expect(result.confidence).toBe(0);
    expect(callMock).toHaveBeenCalledTimes(4);
  });

  it('Established corroboration on both axes → CONFIRMED', async () => {
    const cite = {
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-99999',
      title: 'NVD entry',
      source_tier: 'official' as const,
      excerpt: '',
      supports: 'claim' as const,
    };
    callMock.mockImplementation(async ({ systemPrompt }) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"official","reasoning":"nvd"}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"current","reasoning":"2026"}', citations: [] };
      }
      return {
        text: '{"verdict":"supports","reasoning":"nvd confirms","citation_indices":[1]}',
        citations: [cite],
      };
    });

    const result = await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'premium',
      apiKeys: { anthropic: 'k', together: 'k' },
    });

    expect(result.verdict).toBe('CONFIRMED');
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]?.source_tier).toBe('official');
  });

  it('Threat-axis-flagged misinfo + CONFIRMED → FALSE-ALARM dual-tag', async () => {
    const cite = {
      url: 'https://reuters.com/article',
      title: 'Reuters',
      source_tier: 'established' as const,
      excerpt: '',
      supports: 'claim' as const,
    };
    callMock.mockImplementation(async ({ systemPrompt }) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"established","reasoning":"reuters"}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"current","reasoning":""}', citations: [] };
      }
      return {
        text: '{"verdict":"supports","reasoning":"","citation_indices":[1]}',
        citations: [cite],
      };
    });

    const result = await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'premium',
      apiKeys: { anthropic: 'k', together: 'k' },
      threatAxisFlaggedMisinfo: true,
    });

    expect(result.verdict).toBe('FALSE-ALARM');
    expect(result.dual_tag_false_alarm).toBe(true);
  });

  it('Deterministic across re-runs with identical mocks (no 180° flip)', async () => {
    callMock.mockImplementation(async ({ systemPrompt }) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"unknown","reasoning":""}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"no_signal","reasoning":""}', citations: [] };
      }
      return { text: '{"verdict":"no_signal","reasoning":"","citation_indices":[]}', citations: [] };
    });

    const r1 = await runBSCouncil(p2Input(), { config: CONFIG, tier: 'pro', apiKeys: {} });
    const r2 = await runBSCouncil(p2Input(), { config: CONFIG, tier: 'pro', apiKeys: {} });

    expect(r1.verdict).toBe(r2.verdict);
    expect(r1.confidence).toBe(r2.confidence);
  });

  it('Parser failure (garbage text) → no_signal degraded breakdown, no crash', async () => {
    callMock.mockImplementation(async () => ({ text: 'not json at all', citations: [] }));

    const result = await runBSCouncil(p2Input(), { config: CONFIG, tier: 'pro', apiKeys: {} });
    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.agent_breakdown.A.verdict).toBe('no_signal');
    expect(result.agent_breakdown.B.verdict).toBe('no_signal');
  });
});

describe('web search routing (OL-281)', () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async ({ systemPrompt }: ProviderCallInput) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"unknown","reasoning":""}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"no_signal","reasoning":""}', citations: [] };
      }
      return { text: '{"verdict":"no_signal","reasoning":"","citation_indices":[]}', citations: [] };
    });
  });

  it('Agent A and B receive useWebSearch=true; C and D receive false', async () => {
    await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'premium',
      apiKeys: { anthropic: 'k', together: 'k' },
    });

    const calls = callMock.mock.calls.map((c: any[]) => c[0] as ProviderCallInput);
    const callA = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent A'));
    const callB = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent B'));
    const callC = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent C'));
    const callD = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent D'));

    expect(callA?.useWebSearch).toBe(true);
    expect(callB?.useWebSearch).toBe(true);
    expect(callC?.useWebSearch).toBe(false);
    expect(callD?.useWebSearch).toBe(false);
  });

  it('Agent A searchQuery is a concise string, not the full user message', async () => {
    await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'premium',
      apiKeys: { anthropic: 'k', together: 'k' },
    });

    const calls = callMock.mock.calls.map((c: any[]) => c[0] as ProviderCallInput);
    const callA = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent A'));

    // searchQuery must be a non-empty string shorter than the full userMessage
    expect(typeof callA?.searchQuery).toBe('string');
    expect(callA!.searchQuery!.length).toBeGreaterThan(0);
    expect(callA!.searchQuery!.length).toBeLessThan(callA!.userMessage.length);
  });

  it('Agent B searchQuery is distinct from Agent A searchQuery', async () => {
    await runBSCouncil(p2Input(), {
      config: CONFIG,
      tier: 'premium',
      apiKeys: { anthropic: 'k', together: 'k' },
    });

    const calls = callMock.mock.calls.map((c: any[]) => c[0] as ProviderCallInput);
    const callA = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent A'));
    const callB = calls.find((c: ProviderCallInput) => c.systemPrompt.startsWith('You are Agent B'));

    // A verifies the claim; B targets origin chain — they must use different search angles
    expect(callA?.searchQuery).not.toBe(callB?.searchQuery);
  });
});

describe('runBSCouncilForScan — Gate 1 wrapper', () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async ({ systemPrompt }) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"unknown","reasoning":""}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"no_signal","reasoning":""}', citations: [] };
      }
      return { text: '{"verdict":"no_signal","reasoning":"","citation_indices":[]}', citations: [] };
    });
  });

  it('Free tier short-circuits — never calls providers', async () => {
    const result = await runBSCouncilForScan(
      {
        scan_id: 's',
        content: 'CVE-2024-12345 disclosed today',
        channel: 'browser',
        timestamp: '2026-05-24T12:00:00Z',
      },
      { tier: 'free', apiKeys: {}, config: CONFIG },
    );
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('No Gate-1 trigger → returns null without dispatching', async () => {
    const result = await runBSCouncilForScan(
      {
        scan_id: 's',
        content: 'just a casual message about nothing in particular',
        channel: 'browser',
        timestamp: '2026-05-24T12:00:00Z',
      },
      { tier: 'pro', apiKeys: {}, config: CONFIG },
    );
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('CVE trigger on pro tier fires the council', async () => {
    const result = await runBSCouncilForScan(
      {
        scan_id: 's-cve',
        content: 'CVE-2024-99999 disclosed by Acme, affects 187 packages.',
        channel: 'browser',
        timestamp: '2026-05-24T12:00:00Z',
      },
      { tier: 'pro', apiKeys: { anthropic: 'k', together: 'k' }, config: CONFIG },
    );
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('UNVERIFIED');
    expect(callMock).toHaveBeenCalledTimes(4);
  });

  it('L1 misinfo layer propagates threatAxisFlaggedMisinfo into merge', async () => {
    // Switch mock to a CONFIRMED path so the dual-tag actually fires.
    callMock.mockImplementation(async ({ systemPrompt }) => {
      if (systemPrompt.startsWith('You are Agent C')) {
        return { text: '{"tier":"official","reasoning":""}', citations: [] };
      }
      if (systemPrompt.startsWith('You are Agent D')) {
        return { text: '{"verdict":"current","reasoning":""}', citations: [] };
      }
      return {
        text: '{"verdict":"supports","reasoning":"","citation_indices":[1]}',
        citations: [{ url: 'https://nvd.nist.gov/x', title: 't', source_tier: 'official' as const, excerpt: '', supports: 'claim' as const }],
      };
    });

    const result = await runBSCouncilForScan(
      {
        scan_id: 's-misinfo',
        content: 'CVE-2024-99999 confirmed disclosed by vendor.',
        channel: 'browser',
        timestamp: '2026-05-24T12:00:00Z',
        threat_layers: [{ layer: 'L1', severity: 'medium' }],
      },
      { tier: 'premium', apiKeys: { anthropic: 'k', together: 'k' }, config: CONFIG },
    );

    expect(result?.verdict).toBe('FALSE-ALARM');
    expect(result?.dual_tag_false_alarm).toBe(true);
  });
});
