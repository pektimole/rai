import { describe, it, expect, vi } from 'vitest';

// Mock the Anthropic SDK before importing
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

import Anthropic from '@anthropic-ai/sdk';
import { runProvenanceAgent } from '../agents/provenance.js';
import { runCrossRefAgent } from '../agents/cross-ref.js';
import { runTemporalAgent } from '../agents/temporal.js';
import { runCredibilityAgent } from '../agents/credibility.js';
import { scanP2 } from '../index.js';
import type { P2Input } from '../types.js';

const TEST_INPUT: P2Input = {
  scan_id: 'test-scan-001',
  claim: 'Claude Code source code was leaked on March 31, 2026',
  source_url: 'https://x.com/user/status/12345',
  channel: 'whatsapp',
  p1_verdict: 'flagged',
  p1_confidence: 0.55,
  p1_threat_layers: [
    { layer: 'L1', label: 'Misinformation', signal: 'Unverified claim about source code leak', severity: 'high' },
  ],
  timestamp: '2026-04-02T10:00:00Z',
};

function mockApiResponse(verdict: string, confidence: number) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        verdict,
        confidence,
        reasoning: 'Test reasoning',
        evidence: ['Evidence point 1'],
      }),
    }],
  };
}

function getClient() {
  return vi.mocked(Anthropic).mock.results[0]?.value;
}

describe('agent API integration', () => {
  it('provenance agent calls Claude and parses response', async () => {
    vi.mocked(Anthropic).mockClear();
    const client = { messages: { create: vi.fn().mockResolvedValue(mockApiResponse('supports_claim', 0.85)) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await runProvenanceAgent(TEST_INPUT, 'test-key');
    expect(result.agent).toBe('provenance');
    expect(result.verdict).toBe('supports_claim');
    expect(result.confidence).toBe(0.85);
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('handles malformed JSON gracefully', async () => {
    vi.mocked(Anthropic).mockClear();
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }] }) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await runCrossRefAgent(TEST_INPUT, 'test-key');
    expect(result.agent).toBe('cross-ref');
    expect(result.verdict).toBe('uncertain');
    expect(result.confidence).toBe(0);
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    vi.mocked(Anthropic).mockClear();
    const wrapped = '```json\n{"verdict":"contradicts_claim","confidence":0.9,"reasoning":"test","evidence":[]}\n```';
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: wrapped }] }) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await runTemporalAgent(TEST_INPUT, 'test-key');
    expect(result.verdict).toBe('contradicts_claim');
    expect(result.confidence).toBe(0.9);
  });

  it('clamps confidence to 0-1 range', async () => {
    vi.mocked(Anthropic).mockClear();
    const client = { messages: { create: vi.fn().mockResolvedValue(mockApiResponse('supports_claim', 1.5)) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await runProvenanceAgent(TEST_INPUT, 'test-key');
    expect(result.confidence).toBe(1.0);
  });

  it('credibility agent enriches prompt with source lookup', async () => {
    vi.mocked(Anthropic).mockClear();
    const client = { messages: { create: vi.fn().mockResolvedValue(mockApiResponse('supports_claim', 0.7)) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await runCredibilityAgent(TEST_INPUT, 'test-key');
    expect(result.agent).toBe('credibility');

    const systemPrompt = client.messages.create.mock.calls[0][0].system;
    expect(systemPrompt).toContain('tier="social"');
    expect(systemPrompt).toContain('weight=0.3');
  });
});

describe('scanP2 orchestration', () => {
  it('runs all 4 agents and merges verdicts', async () => {
    vi.mocked(Anthropic).mockClear();
    const client = { messages: { create: vi.fn().mockResolvedValue(mockApiResponse('supports_claim', 0.8)) } };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await scanP2(TEST_INPUT, 'test-key');

    expect(result.scan_id).toBe('test-scan-001');
    expect(result.agent_verdicts).toHaveLength(4);
    expect(result.consensus_verdict).toBe('confirmed_threat');
    expect(result.recommended_action).toBe('block');
    expect(result.disagreement).toBe(false);
  });

  it('flags disagreement when agents split', async () => {
    vi.mocked(Anthropic).mockClear();
    let callCount = 0;
    const client = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          callCount++;
          const v = callCount % 2 === 0 ? 'contradicts_claim' : 'supports_claim';
          return Promise.resolve(mockApiResponse(v, 0.7));
        }),
      },
    };
    vi.mocked(Anthropic).mockImplementation(() => client as any);

    const result = await scanP2(TEST_INPUT, 'test-key');
    expect(result.disagreement).toBe(true);
    expect(result.recommended_action).toBe('human_review');
  });
});
