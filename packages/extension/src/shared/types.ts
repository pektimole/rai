export type ThreatLayer = 'L-2' | 'L-1' | 'L0' | 'L1' | 'L2' | 'L3';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Verdict = 'clean' | 'flagged' | 'blocked';
export type RecommendedAction = 'pass' | 'warn' | 'quarantine' | 'block';
export type ScanSource = 'clipboard' | 'input' | 'ai_response';

export interface ThreatSignal {
  layer: ThreatLayer;
  label: string;
  signal: string;
  severity: Severity;
  matched_pattern?: string;
}

export interface ScanResult {
  scan_id: string;
  verdict: Verdict;
  confidence: number;
  threat_layers: ThreatSignal[];
  recommended_action: RecommendedAction;
  explanation: string;
  raw_signals: string[];
}

export interface ScanRequest {
  action: 'scan';
  content: string;
  source: ScanSource;
  url: string;
}

export interface ScanResponse {
  verdict: Verdict;
  confidence: number;
  threat_layers: ThreatSignal[];
  explanation: string;
}
