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
