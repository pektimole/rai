/**
 * Ollama provider adapter — local open-weight models.
 *
 * Used when zero-network grounding is required (Free-tier compatible D agent),
 * or as the local fallback for B when cloud open-weight is unavailable.
 *
 * Web search: same pattern as TogetherAdapter — injection via web-search.ts
 * before the model call.
 */

import type { ProviderAdapter, ProviderCallInput, ProviderCallResult } from './types.js';
import { fetchWebSearchSnippets } from './web-search.js';

const OLLAMA_DEFAULT_BASE = 'http://localhost:11434/api';

export class OllamaAdapter implements ProviderAdapter {
  readonly name = 'ollama';

  supportsWebSearch(): boolean {
    return false;
  }

  async call(input: ProviderCallInput): Promise<ProviderCallResult> {
    const baseUrl = input.config.baseUrl ?? OLLAMA_DEFAULT_BASE;

    let userMessage = input.userMessage;
    let citations: ProviderCallResult['citations'] = [];

    if (input.useWebSearch) {
      const search = await fetchWebSearchSnippets(input.userMessage);
      citations = search.citations;
      userMessage =
        `${input.userMessage}\n\n` +
        `Web search results (cite these in your answer):\n${search.snippets}`;
    }

    const res = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        options: { num_predict: input.maxTokens ?? 1024 },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OllamaAdapter call failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    return {
      text: data.message?.content ?? '',
      citations,
      usage: {
        input_tokens: data.prompt_eval_count,
        output_tokens: data.eval_count,
      },
    };
  }
}

interface OllamaChatResponse {
  message?: { content: string };
  prompt_eval_count?: number;
  eval_count?: number;
}
