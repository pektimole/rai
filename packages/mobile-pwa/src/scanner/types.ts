/**
 * Shared scanner types for the mobile PWA.
 *
 * Ported verbatim from `packages/extension/src/shared/types.ts` so corpus rows
 * exported from the PWA join cleanly with extension exports + Telegram lab-bot
 * output. Keep the two copies in sync until/unless we promote this to a
 * browser-safe `@rai/types` workspace.
 */

export type ThreatLayer = 'L-2' | 'L-1' | 'L0' | 'L1' | 'L2' | 'L3';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type Verdict = 'clean' | 'flagged' | 'blocked';
export type RecommendedAction = 'pass' | 'warn' | 'quarantine' | 'block';
export type ScanSource = 'clipboard' | 'input' | 'ai_response' | 'share';

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
