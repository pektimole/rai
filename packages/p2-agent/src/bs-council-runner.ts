/**
 * BS Council runner — dispatches the four roles to heterogeneous providers in parallel.
 *
 * Each role gets:
 *  - a distinct query angle (spec § Agent role mapping)
 *  - a distinct model family (spec § Heterogeneous models)
 *  - a verdict parser specific to its role (parseAB / parseC / parseD)
 *
 * Failures fall through to no_signal for that role; mergeBSVerdicts handles degradation.
 */

import type {
  AgentABVerdict,
  AgentConfig,
  AgentDVerdict,
  BSCouncilResult,
  Citation,
  CouncilBreakdownA,
  CouncilBreakdownB,
  CouncilBreakdownC,
  CouncilBreakdownD,
  CouncilConfig,
  CredibilityTier,
  P2Input,
  RaiTier,
} from './types.js';
import { getProvider, type ProviderCallInput } from './providers/index.js';
import { resolveAgentConfig, loadCouncilConfig } from './council-config.js';
import { mergeBSVerdicts } from './bs-council.js';
import { lookupCredibility } from './agents/credibility.js';
import { shouldRunBSCouncil, extractVerifiableClaim, type Gate1Input } from './gate1.js';

export interface RunBSCouncilOptions {
  config: CouncilConfig;
  tier: RaiTier;
  apiKeys: {
    anthropic?: string;
    together?: string;
  };
  threatAxisFlaggedMisinfo?: boolean;
}

const PROMPT_A = `You are Agent A in the RAI BS Council. Your job is independent corroboration.
Given a CLAIM and web search results, decide whether independent sources confirm it.

Output strict JSON:
{
  "verdict": "supports" | "contradicts" | "no_signal",
  "reasoning": "<one sentence>",
  "citation_indices": [<integers referencing the numbered search results that back your verdict>]
}

Rules:
- "supports" requires at least one tier ≥ established source.
- "contradicts" requires at least one source explicitly refuting the claim.
- If sources are thin, irrelevant, or only social-tier, output "no_signal".
- Never invent citations. Only reference numbered indices from the provided results.`;

const PROMPT_B = `You are Agent B in the RAI BS Council. Your job is origin-chain verification.
Given a CLAIM (with extracted entities) and web search results, decide whether the claim's origin chain checks out.

Output strict JSON:
{
  "verdict": "supports" | "contradicts" | "no_signal",
  "reasoning": "<one sentence about who reported it first and whether it propagated honestly>",
  "citation_indices": [<integers>]
}

Rules:
- "supports" = official disclosure channel found OR consistent reporting from independent established sources.
- "contradicts" = origin traces to a hoax/parody site, fabricated press release, or contradicting primary source.
- "no_signal" = origin unclear, no primary source surfaces.`;

const PROMPT_C = `You are Agent C in the RAI BS Council. Your job is source credibility classification.
Given a CLAIM and its source URL (if any), classify the source tier.

Output strict JSON:
{
  "tier": "official" | "established" | "community" | "social" | "anonymous" | "unknown",
  "reasoning": "<one sentence>"
}

If no source URL is provided, output "unknown".`;

const PROMPT_D = `You are Agent D in the RAI BS Council. Your job is temporal verification.
Given a CLAIM that contains a date or temporal anchor, decide whether the claim is current, outdated, or superseded.

Output strict JSON:
{
  "verdict": "current" | "outdated" | "superseded" | "no_signal",
  "reasoning": "<one sentence referencing the date you anchored on>"
}

Rules:
- "current" = claim is within the validity window of the named event/version.
- "outdated" = claim references a version/event that has been replaced by a newer one.
- "superseded" = a more recent verified claim explicitly contradicts this one.
- "no_signal" = no temporal anchor extractable.`;

export async function runBSCouncil(
  input: P2Input,
  options: RunBSCouncilOptions,
): Promise<BSCouncilResult> {
  const { config, tier, apiKeys, threatAxisFlaggedMisinfo } = options;

  const [A, B, C, D] = await Promise.all([
    runRoleA(input, resolveAgentConfig('A', config, tier), apiKeys),
    runRoleB(input, resolveAgentConfig('B', config, tier), apiKeys),
    runRoleC(input, resolveAgentConfig('C', config, tier), apiKeys),
    runRoleD(input, resolveAgentConfig('D', config, tier), apiKeys),
  ]);

  return mergeBSVerdicts({ scanId: input.scan_id, A, B, C, D, threatAxisFlaggedMisinfo });
}

async function runRoleA(
  input: P2Input,
  cfg: AgentConfig | null,
  apiKeys: RunBSCouncilOptions['apiKeys'],
): Promise<CouncilBreakdownA> {
  const query = `${input.claim} verify source`;
  if (!cfg) return noSignalA(query);

  try {
    const result = await callWithFallback(cfg, apiKeys, {
      systemPrompt: PROMPT_A,
      userMessage: buildABUserMessage(input, query),
      web_search: cfg.web_search ?? true,
      searchQuery: query,
    });
    const parsed = parseABResponse(result.text);
    const cited = mapCitationIndices(parsed.citation_indices, result.citations, parsed.verdict);
    return {
      role: 'A',
      verdict: parsed.verdict,
      citations: cited,
      query,
      provider: cfg.provider,
      model: cfg.model,
    };
  } catch (err) {
    if (process.env.RAI_DEBUG) console.error('[Agent A] error:', err);
    return noSignalA(query, cfg);
  }
}

async function runRoleB(
  input: P2Input,
  cfg: AgentConfig | null,
  apiKeys: RunBSCouncilOptions['apiKeys'],
): Promise<CouncilBreakdownB> {
  const entities = extractEntities(input.claim);
  const query = `${entities} first reported official disclosure`;
  if (!cfg) return noSignalB(query);

  try {
    const result = await callWithFallback(cfg, apiKeys, {
      systemPrompt: PROMPT_B,
      userMessage: buildABUserMessage(input, query),
      web_search: cfg.web_search ?? true,
      searchQuery: query,
    });
    const parsed = parseABResponse(result.text);
    const cited = mapCitationIndices(parsed.citation_indices, result.citations, parsed.verdict);
    return {
      role: 'B',
      verdict: parsed.verdict,
      citations: cited,
      query,
      provider: cfg.provider,
      model: cfg.model,
    };
  } catch (err) {
    if (process.env.RAI_DEBUG) console.error('[Agent B] error:', err);
    return noSignalB(query, cfg);
  }
}

async function runRoleC(
  input: P2Input,
  cfg: AgentConfig | null,
  apiKeys: RunBSCouncilOptions['apiKeys'],
): Promise<CouncilBreakdownC> {
  if (!cfg) return noSignalC();
  // Short-circuit: registry-only path is cheap and deterministic.
  if (input.source_url) {
    try {
      const host = new URL(input.source_url).hostname;
      const tier = lookupCredibility(host);
      if (tier) {
        return {
          role: 'C',
          tier,
          weight: tierWeight(tier),
          reasoning: `Registry tier for ${host}: ${tier}.`,
          provider: 'registry',
          model: 'credibility-seed',
        };
      }
    } catch {
      // fall through to LLM
    }
  }

  try {
    const result = await callWithFallback(cfg, apiKeys, {
      systemPrompt: PROMPT_C,
      userMessage: `Claim: "${input.claim}"\nSource URL: ${input.source_url ?? '(none)'}`,
      web_search: false,
    });
    const parsed = parseCResponse(result.text);
    return {
      role: 'C',
      tier: parsed.tier,
      weight: parsed.tier === 'unknown' ? 0.5 : tierWeight(parsed.tier),
      reasoning: parsed.reasoning,
      provider: cfg.provider,
      model: cfg.model,
    };
  } catch (err) {
    if (process.env.RAI_DEBUG) console.error('[Agent C] error:', err);
    return noSignalC();
  }
}

async function runRoleD(
  input: P2Input,
  cfg: AgentConfig | null,
  apiKeys: RunBSCouncilOptions['apiKeys'],
): Promise<CouncilBreakdownD> {
  if (!cfg) return { role: 'D', verdict: 'no_signal', reasoning: 'Agent D gated off for tier.', provider: 'none', model: 'none' };

  try {
    const result = await callWithFallback(cfg, apiKeys, {
      systemPrompt: PROMPT_D,
      userMessage: `Claim: "${input.claim}"\nClaim timestamp: ${input.timestamp}`,
      web_search: cfg.web_search ?? false,
    });
    const parsed = parseDResponse(result.text);
    return {
      role: 'D',
      verdict: parsed.verdict,
      reasoning: parsed.reasoning,
      provider: cfg.provider,
      model: cfg.model,
    };
  } catch {
    return { role: 'D', verdict: 'no_signal', reasoning: 'Agent D call failed.', provider: cfg.provider, model: cfg.model };
  }
}

interface CallSpec {
  systemPrompt: string;
  userMessage: string;
  web_search: boolean;
  /** Concise query string for external web search (Brave). Separate from userMessage. */
  searchQuery?: string;
}

async function callWithFallback(
  cfg: AgentConfig,
  apiKeys: RunBSCouncilOptions['apiKeys'],
  spec: CallSpec,
) {
  try {
    return await dispatchProvider(cfg, apiKeys, spec);
  } catch (err) {
    if (process.env.RAI_DEBUG) console.error(`[callWithFallback] primary(${cfg.provider}/${cfg.model}) failed:`, err);
    if (cfg.fallback_local) {
      if (process.env.RAI_DEBUG) console.error(`[callWithFallback] trying fallback_local: ${cfg.fallback_local.provider}/${cfg.fallback_local.model}`);
      return await dispatchProvider(cfg.fallback_local, apiKeys, spec);
    }
    if (cfg.fallback_cloud) {
      if (process.env.RAI_DEBUG) console.error(`[callWithFallback] trying fallback_cloud: ${cfg.fallback_cloud.provider}/${cfg.fallback_cloud.model}`);
      return await dispatchProvider(cfg.fallback_cloud, apiKeys, spec);
    }
    throw err;
  }
}

async function dispatchProvider(
  cfg: AgentConfig,
  apiKeys: RunBSCouncilOptions['apiKeys'],
  spec: CallSpec,
) {
  const provider = getProvider(cfg.provider);
  const callInput: ProviderCallInput = {
    systemPrompt: spec.systemPrompt,
    userMessage: spec.userMessage,
    model: cfg.model,
    useWebSearch: spec.web_search && (cfg.web_search ?? false),
    searchQuery: spec.searchQuery,
    config: {
      apiKey: cfg.provider === 'anthropic' ? apiKeys.anthropic : cfg.provider === 'together' ? apiKeys.together : undefined,
    },
    maxTokens: 768,
  };
  return await provider.call(callInput);
}

// ────────── parsers ──────────

interface ParsedAB {
  verdict: AgentABVerdict;
  reasoning: string;
  citation_indices: number[];
}

function parseABResponse(text: string): ParsedAB {
  const json = extractJson(text);
  if (!json) return { verdict: 'no_signal', reasoning: 'parse failure', citation_indices: [] };
  const candidates = ['supports', 'contradicts', 'no_signal'] as const;
  const verdict: AgentABVerdict = candidates.includes(json.verdict as AgentABVerdict)
    ? (json.verdict as AgentABVerdict)
    : 'no_signal';
  return {
    verdict,
    reasoning: typeof json.reasoning === 'string' ? json.reasoning : '',
    citation_indices: Array.isArray(json.citation_indices)
      ? json.citation_indices.filter((i: unknown): i is number => typeof i === 'number')
      : [],
  };
}

function parseCResponse(text: string): { tier: CredibilityTier | 'unknown'; reasoning: string } {
  const json = extractJson(text);
  if (!json) return { tier: 'unknown', reasoning: 'parse failure' };
  const validTiers = new Set(['official', 'established', 'community', 'social', 'anonymous', 'unknown']);
  const rawTier = typeof json.tier === 'string' ? json.tier : '';
  const tier = validTiers.has(rawTier) ? (rawTier as CredibilityTier | 'unknown') : 'unknown';
  return { tier, reasoning: typeof json.reasoning === 'string' ? json.reasoning : '' };
}

function parseDResponse(text: string): { verdict: AgentDVerdict; reasoning: string } {
  const json = extractJson(text);
  if (!json) return { verdict: 'no_signal', reasoning: 'parse failure' };
  const valid = new Set(['current', 'outdated', 'superseded', 'no_signal']);
  const rawVerdict = typeof json.verdict === 'string' ? json.verdict : '';
  const verdict = valid.has(rawVerdict) ? (rawVerdict as AgentDVerdict) : 'no_signal';
  return { verdict, reasoning: typeof json.reasoning === 'string' ? json.reasoning : '' };
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ────────── helpers ──────────

function buildABUserMessage(input: P2Input, query: string): string {
  return [
    `Claim: "${input.claim}"`,
    `Channel: ${input.channel}`,
    `Source URL: ${input.source_url ?? '(none)'}`,
    `Search query used by the orchestrator (if web_search is unavailable, ground only on these snippets): ${query}`,
  ].join('\n');
}

function extractEntities(claim: string): string {
  // Minimal extraction: CVE IDs, capitalized multi-word terms, quoted phrases.
  const cves = claim.match(/CVE-\d{4}-\d{4,7}/gi) ?? [];
  const quoted = claim.match(/"([^"]+)"/g)?.map(q => q.replace(/"/g, '')) ?? [];
  const capitalized = claim.match(/\b[A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+){0,3}\b/g) ?? [];
  const entities = [...new Set([...cves, ...quoted, ...capitalized])].slice(0, 5);
  return entities.length > 0 ? entities.join(' ') : claim.slice(0, 80);
}

function mapCitationIndices(
  indices: number[],
  available: Citation[],
  verdict: AgentABVerdict,
): Citation[] {
  if (indices.length === 0 || available.length === 0) return [];
  const supportsLabel: Citation['supports'] =
    verdict === 'supports' ? 'claim' : verdict === 'contradicts' ? 'counter' : 'context';
  return indices
    .map(i => available[i - 1])
    .filter((c): c is Citation => Boolean(c))
    .map(c => ({ ...c, supports: supportsLabel }));
}

function tierWeight(tier: CredibilityTier): number {
  switch (tier) {
    case 'official': return 0.9;
    case 'established': return 0.7;
    case 'community': return 0.5;
    case 'social': return 0.3;
    case 'anonymous': return 0.1;
  }
}

// ────────── degraded results ──────────

function noSignalA(query: string, cfg?: AgentConfig): CouncilBreakdownA {
  return { role: 'A', verdict: 'no_signal', citations: [], query, provider: cfg?.provider ?? 'none', model: cfg?.model ?? 'none' };
}

function noSignalB(query: string, cfg?: AgentConfig): CouncilBreakdownB {
  return { role: 'B', verdict: 'no_signal', citations: [], query, provider: cfg?.provider ?? 'none', model: cfg?.model ?? 'none' };
}

function noSignalC(): CouncilBreakdownC {
  return { role: 'C', tier: 'unknown', weight: 0.5, reasoning: 'Agent C unavailable.', provider: 'none', model: 'none' };
}

// ────────── high-level entry: scan → council ──────────

export interface RunBSCouncilForScanInput {
  scan_id: string;
  content: string;
  channel: string;
  timestamp: string;
  source_url?: string;
  threat_layers?: Array<{ layer: string; severity?: string }>;
  verdict?: 'clean' | 'flagged' | 'blocked';
  p1_confidence?: number;
}

export interface RunBSCouncilForScanOptions {
  apiKeys: { anthropic?: string; together?: string };
  tier: RaiTier;
  config?: CouncilConfig;
}

/**
 * High-level wrapper: takes a P1 scan payload, runs Gate 1, fires the BS Council
 * if triggered, returns null otherwise. Free tier always returns null.
 *
 * Spec: 26-rai-p2-spec.md § Two-Gate Protocol § Gate 1 + tier gating.
 */
export async function runBSCouncilForScan(
  input: RunBSCouncilForScanInput,
  options: RunBSCouncilForScanOptions,
): Promise<BSCouncilResult | null> {
  if (options.tier === 'free') return null;

  const gate1Input: Gate1Input = {
    content: input.content,
    threat_layers: input.threat_layers,
    verdict: input.verdict,
  };
  const gate1 = shouldRunBSCouncil(gate1Input);
  if (!gate1.trigger) return null;

  const claim = gate1.claim || extractVerifiableClaim(input.content);
  if (!claim) return null;

  const config = options.config ?? loadCouncilConfig();
  const threatAxisFlaggedMisinfo = (input.threat_layers ?? []).some(t => t.layer === 'L1');

  const p2Input: P2Input = {
    scan_id: input.scan_id,
    claim,
    source_url: input.source_url,
    channel: input.channel,
    p1_verdict: input.verdict === 'blocked' ? 'blocked' : 'flagged',
    p1_confidence: input.p1_confidence ?? 0.5,
    p1_threat_layers: (input.threat_layers ?? []).map(t => ({
      layer: t.layer,
      label: t.layer,
      signal: '',
      severity: (t.severity as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
    })),
    timestamp: input.timestamp,
  };

  return runBSCouncil(p2Input, {
    config,
    tier: options.tier,
    apiKeys: options.apiKeys,
    threatAxisFlaggedMisinfo,
  });
}
