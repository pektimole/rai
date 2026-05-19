/**
 * Anthropic provider adapter. Native web_search tool when requested.
 * Models: claude-sonnet-4-6, claude-haiku-4-5-20251001, claude-opus-4-7.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CredibilityTier } from '../types.js';
import { lookupCredibility } from '../agents/credibility.js';
import type { ProviderAdapter, ProviderCallInput, ProviderCallResult } from './types.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';

  supportsWebSearch(): boolean {
    return true;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallResult> {
    const apiKey = input.config.apiKey;
    if (!apiKey) throw new Error('AnthropicAdapter: apiKey required in config');

    const client = new Anthropic({ apiKey });

    const tools = input.useWebSearch
      ? ([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] as unknown as Anthropic.Tool[])
      : undefined;

    const response = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userMessage }],
      ...(tools ? { tools } : {}),
    });

    const textParts: string[] = [];
    const citations: ProviderCallResult['citations'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        // Anthropic surfaces citations inline on text blocks when web_search is used
        const inline = (block as unknown as { citations?: AnthropicInlineCitation[] }).citations;
        if (Array.isArray(inline)) {
          for (const c of inline) {
            const tier = sourceTier(c.url);
            citations.push({
              url: c.url,
              title: c.title ?? c.url,
              source_tier: tier,
              published_at: c.encrypted_index ? undefined : undefined,
              excerpt: c.cited_text?.slice(0, 280) ?? '',
              supports: 'context',
            });
          }
        }
      }
    }

    return {
      text: textParts.join('\n'),
      citations,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

interface AnthropicInlineCitation {
  url: string;
  title?: string;
  cited_text?: string;
  encrypted_index?: string;
}

function sourceTier(url: string): CredibilityTier {
  try {
    const host = new URL(url).hostname;
    return lookupCredibility(host) ?? 'community';
  } catch {
    return 'anonymous';
  }
}
