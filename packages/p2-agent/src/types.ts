/**
 * RAI P2 Types — Multi-agent consensus architecture
 * Spec: docs/26-rai-p2-spec.md
 */

export interface P2Input {
  scan_id: string;
  claim: string;
  source_url?: string;
  channel: string;
  p1_verdict: 'flagged' | 'blocked';
  p1_confidence: number;
  p1_threat_layers: ThreatLayerResult[];
  timestamp: string;
}

export interface ThreatLayerResult {
  layer: string;
  label: string;
  signal: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface AgentVerdict {
  agent: 'provenance' | 'cross-ref' | 'temporal' | 'credibility';
  verdict: 'supports_claim' | 'contradicts_claim' | 'uncertain';
  confidence: number;
  reasoning: string;
  evidence: string[];
}

export type CredibilityTier = 'official' | 'established' | 'community' | 'social' | 'anonymous';

export interface SourceCredibility {
  url_pattern: string;
  tier: CredibilityTier;
  weight: number;
}

export interface ScanHistoryEntry {
  scan_id: string;
  timestamp: string;
  channel: string;
  verdict: string;
  confidence: number;
  claim_hash: string;
  source_url?: string;
}

// ────────────────────────────────────────────────────────────
// BS Council — verifiability axis (OL-281, spec 26-rai-p2-spec.md)
// ────────────────────────────────────────────────────────────

export type BSCouncilVerdict =
  | 'CONFIRMED'
  | 'CONTESTED'
  | 'UNVERIFIED'
  | 'FALSE-ALARM';

export type CouncilRole = 'A' | 'B' | 'C' | 'D';

export interface Citation {
  url: string;
  title: string;
  source_tier: CredibilityTier;
  published_at?: string;
  excerpt: string;
  supports: 'claim' | 'counter' | 'context';
}

export type AgentABVerdict = 'supports' | 'contradicts' | 'no_signal';
export type AgentDVerdict = 'current' | 'outdated' | 'superseded' | 'no_signal';

export interface CouncilBreakdownA { role: 'A'; verdict: AgentABVerdict; citations: Citation[]; query: string; provider: string; model: string; }
export interface CouncilBreakdownB { role: 'B'; verdict: AgentABVerdict; citations: Citation[]; query: string; provider: string; model: string; }
export interface CouncilBreakdownC { role: 'C'; tier: CredibilityTier | 'unknown'; weight: number; reasoning: string; provider: string; model: string; }
export interface CouncilBreakdownD { role: 'D'; verdict: AgentDVerdict; reasoning: string; provider: string; model: string; }

export type CouncilBreakdown =
  | CouncilBreakdownA
  | CouncilBreakdownB
  | CouncilBreakdownC
  | CouncilBreakdownD;

export interface BSCouncilResult {
  scan_id: string;
  axis: 'verifiability';
  verdict: BSCouncilVerdict;
  confidence: number;
  agent_breakdown: {
    A: CouncilBreakdownA;
    B: CouncilBreakdownB;
    C: CouncilBreakdownC;
    D: CouncilBreakdownD;
  };
  citations: Citation[];
  explanation: string;
  dual_tag_false_alarm?: boolean;
  /**
   * OL-395 hard rule: UNVERIFIED does NOT mean clean.
   * Absence of web corroboration is not a safe verdict.
   * Downstream consumers must NOT treat UNVERIFIED as equivalent to CONFIRMED.
   */
  unverified_not_clean?: true;
}

export type ProviderName = 'anthropic' | 'together' | 'ollama';
export type RaiTier = 'free' | 'pro' | 'premium';

export interface AgentConfig {
  provider: ProviderName;
  model: string;
  web_search?: boolean;
  fallback_local?: AgentConfig;
  fallback_cloud?: AgentConfig;
}

export interface CouncilConfig {
  agents: { A: AgentConfig; B: AgentConfig; C: AgentConfig; D: AgentConfig };
  tier_overrides: {
    free: null | Partial<Record<CouncilRole, AgentConfig | null>>;
    pro: null | Partial<Record<CouncilRole, AgentConfig | null>>;
    premium: 'use defaults' | Partial<Record<CouncilRole, AgentConfig | null>>;
  };
}
