/**
 * Provider registry — pick adapter by name.
 */

import type { ProviderAdapter } from './types.js';
import { AnthropicAdapter } from './anthropic.js';
import { TogetherAdapter } from './together.js';
import { OllamaAdapter } from './ollama.js';
import type { ProviderName } from '../types.js';

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  together: new TogetherAdapter(),
  ollama: new OllamaAdapter(),
};

export function getProvider(name: ProviderName): ProviderAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`Unknown provider: ${name}`);
  return adapter;
}

export type { ProviderAdapter, ProviderCallInput, ProviderCallResult, ProviderConfig } from './types.js';
