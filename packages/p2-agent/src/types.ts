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

export interface P2Result {
  scan_id: string;
  consensus_verdict: 'confirmed_threat' | 'likely_threat' | 'uncertain' | 'likely_safe' | 'false_positive';
  consensus_confidence: number;
  agent_verdicts: AgentVerdict[];
  disagreement: boolean;
  explanation: string;
  recommended_action: 'block' | 'warn' | 'pass' | 'human_review';
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

/** Adaptive weights for P2 consensus, loaded from p2-weights.json. */
export interface P2Weights {
  agent_weights: {
    provenance: number;
    'cross-ref': number;
    temporal: number;
    credibility: number;
  };
  consensus_thresholds: {
    confirmed_threat_min_supporting: number;
    likely_threat_min_supporting: number;
    false_positive_min_contradicting: number;
    likely_safe_min_contradicting: number;
    human_review_min_uncertain: number;
  };
}
