/**
 * Types for the RAI red-team test suite.
 */

export type ThreatLayer = 'L-2' | 'L-1' | 'L0' | 'L1';
export type ExpectedVerdict = 'clean' | 'flagged' | 'blocked';
export type Variant = 'canonical' | 'paraphrased' | 'obfuscated' | 'unicode' | 'multi-stage';

/** A single payload loaded from YAML. */
export interface Payload {
  id: string;
  layer: ThreatLayer;
  expected_verdict: ExpectedVerdict;
  /** Optional label to match against threat_layers[].label. */
  expected_label?: string;
  variant: Variant;
  payload: string;
  /** If true, P1 must be run (P0 alone cannot detect). */
  p1_required?: boolean;
  /** Free-text note for context / negative-control explanation. */
  note?: string;
}

/** Result of running a single payload through the scanners. */
export interface PayloadResult {
  payload_id: string;
  layer: ThreatLayer;
  expected_verdict: ExpectedVerdict;
  actual_verdict: ExpectedVerdict;
  expected_label?: string;
  actual_labels: string[];
  tier_used: 'p0' | 'p0+p1';
  /** true = verdict matches expectation. */
  pass: boolean;
  /** If label was specified but not found in actual scan. */
  label_missed: boolean;
  /** Latency in ms for the scan execution. */
  latency_ms: number;
  /** Raw scan_id from the P0/P1 scan for traceability. */
  scan_id: string;
}

/** Aggregate report across all payloads. */
export interface SuiteReport {
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  by_layer: Record<ThreatLayer, { total: number; passed: number; failed: number }>;
  by_variant: Record<Variant, { total: number; passed: number; failed: number }>;
  failures: PayloadResult[];
  /** Average scan latency in ms. */
  avg_latency_ms: number;
}
