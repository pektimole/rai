/**
 * Provider adapter interface — heterogeneous model dispatch for BS Council.
 *
 * Why this exists: BS Council Agent A and Agent B must run on different vendors
 * to avoid same-vendor convergence (training-data + RLHF bias correlation).
 * Each provider exposes the same shape so the council dispatcher is provider-agnostic.
 */

import type { Citation } from '../types.js';

export interface ProviderCallInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
  /** When true, the provider should perform web search before answering. */
  useWebSearch: boolean;
  /**
   * Concise search query for external web lookup (Brave etc.).
   * Separate from userMessage because userMessage contains formatting prose
   * that Brave will reject. Defaults to userMessage when omitted (legacy path).
   */
  searchQuery?: string;
  /** Provider-specific config (API key, base URL, etc.) */
  config: ProviderConfig;
  /** Max tokens for the response. */
  maxTokens?: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderCallResult {
  /** Raw text response from the model. */
  text: string;
  /** Citations gathered during web search, if applicable. Empty when useWebSearch=false. */
  citations: Citation[];
  /** Free-form usage info; provider-specific. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ProviderAdapter {
  readonly name: string;
  call(input: ProviderCallInput): Promise<ProviderCallResult>;
  /** Whether this provider supports native web search (vs requiring an external tool). */
  supportsWebSearch(): boolean;
}
