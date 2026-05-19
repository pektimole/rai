/**
 * Together AI provider adapter. Open-weight models cloud-hosted:
 * Qwen3-72B, Llama-3.3-70B, DeepSeek-V3.
 *
 * Web search: Together does not have a native tool; the council orchestrator
 * pre-fetches search results and injects them into the user message when
 * useWebSearch=true. The search fn lives in providers/web-search.ts.
 */

import type { ProviderAdapter, ProviderCallInput, ProviderCallResult } from './types.js';
import { fetchWebSearchSnippets } from './web-search.js';

const TOGETHER_DEFAULT_BASE = 'https://api.together.xyz/v1';

export class TogetherAdapter implements ProviderAdapter {
  readonly name = 'together';

  supportsWebSearch(): boolean {
    return false;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallResult> {
    const apiKey = input.config.apiKey;
    if (!apiKey) throw new Error('TogetherAdapter: apiKey required in config');
    const baseUrl = input.config.baseUrl ?? TOGETHER_DEFAULT_BASE;

    let userMessage = input.userMessage;
    let citations: ProviderCallResult['citations'] = [];

    if (input.useWebSearch) {
      const search = await fetchWebSearchSnippets(input.userMessage);
      citations = search.citations;
      userMessage =
        `${input.userMessage}\n\n` +
        `Web search results (use these to ground your answer; do not invent sources):\n` +
        search.snippets;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens ?? 1024,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TogetherAdapter call failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as TogetherChatResponse;
    const text = data.choices[0]?.message?.content ?? '';

    return {
      text,
      citations,
      usage: {
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
      },
    };
  }
}

interface TogetherChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
