/**
 * Council config loader + tier-override resolution.
 *
 * Resolution rules (spec § Tier mapping):
 *   - free:    null per role = agent disabled, council degrades to UNVERIFIED
 *   - pro:     overrides primarily map B/D to local ollama; C disabled to save BYOK budget
 *   - premium: use defaults (cloud + local mix)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AgentConfig, CouncilConfig, CouncilRole, RaiTier } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, '..', 'config', 'p2-council.json');

let _cached: CouncilConfig | null = null;

export function loadCouncilConfig(path?: string): CouncilConfig {
  if (!path && _cached) return _cached;
  const raw = readFileSync(path ?? DEFAULT_CONFIG_PATH, 'utf-8');
  const cfg = JSON.parse(raw) as CouncilConfig;
  if (!path) _cached = cfg;
  return cfg;
}

/**
 * Resolve the AgentConfig for a given role + tier. Returns null when the agent
 * is gated off for that tier (e.g. Free disables all agents).
 */
export function resolveAgentConfig(
  role: CouncilRole,
  config: CouncilConfig,
  tier: RaiTier,
): AgentConfig | null {
  const override = config.tier_overrides[tier];

  if (override === 'use defaults' || override === null || override === undefined) {
    return config.agents[role];
  }

  if (role in override) {
    return (override as Partial<Record<CouncilRole, AgentConfig | null>>)[role] ?? null;
  }

  return config.agents[role];
}

/** Reset internal cache. Test-only. */
export function _resetCouncilConfigCache(): void {
  _cached = null;
}
