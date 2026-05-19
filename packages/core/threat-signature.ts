/**
 * threat-signature.ts — RAI Network Architecture: canonical threat signature format
 *
 * A ThreatSignature is the distilled unit that flows through the private layer
 * (Phase 1) and eventually the community pool (Phase 2). It summarises observed
 * detections for a given (layer, label) pair without storing raw scan payloads.
 *
 * Design constraints:
 *   - pattern_hint is a non-extractable summary string, never the live regex
 *   - source is always 'private' in Phase 1; 'community' reserved for Phase 2
 *   - IDs are deterministic (sha256 of layer+label), stable across reinstalls
 */

import { createHash } from 'crypto';
import type { ThreatLayer, Severity } from './rai-scan-p0.js';

// Re-export so consumers only import from this module
export type { ThreatLayer, Severity };

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ThreatSignature {
  /** sha256(layer:label)[:16] — deterministic, stable across reinstalls */
  id: string;
  /** Monotonic counter, incremented each time dream-phase updates this sig */
  version: number;
  layer: ThreatLayer;
  label: string;
  /**
   * Human-readable hint. NOT the original regex — cannot be used to reconstruct
   * the detection rule. Example: "L0:Direct prompt injection"
   */
  pattern_hint: string;
  /** Total observations since first_seen */
  sample_count: number;
  /** [0, 1] — weighted by severity distribution + log-frequency bonus */
  confidence: number;
  first_seen: string; // ISO
  last_seen: string;  // ISO
  source: 'private' | 'community'; // Phase 1: always 'private'
  severity_distribution: Record<Severity, number>;
  /** Which surfaces have observed this pattern (populated from scan event surface field) */
  surfaces_observed?: string[];
}

export interface ThreatSignatureStore {
  /** Bump when the format changes to trigger migration */
  schema_version: number;
  /** Stable random UUID for this private layer instance */
  instance_id: string;
  created: string;        // ISO — when this store was first written
  last_dream_phase: string | null; // ISO — last successful distillation run
  dream_phase_count: number;
  signatures: ThreatSignature[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic, collision-resistant ID for a (layer, label) pair.
 * Returns the first 16 hex chars of sha256("layer:label").
 */
export function signatureId(layer: ThreatLayer, label: string): string {
  return createHash('sha256')
    .update(`${layer}:${label}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Compute a [0, 1] confidence score from a severity distribution.
 *
 * Formula:
 *   weighted = (critical×1.0 + high×0.75 + medium×0.5 + low×0.25) / total
 *   freq_bonus = min(log10(total + 1), 1.0)          — asymptotes at 1.0
 *   confidence = weighted × (0.5 + 0.5 × freq_bonus) — [0, 1]
 *
 * Effect: a single critical hit → ~0.65; 10 critical hits → ~0.95.
 */
export function computeConfidence(dist: Record<Severity, number>): number {
  const total = dist.low + dist.medium + dist.high + dist.critical;
  if (total === 0) return 0;
  const weighted =
    (dist.critical * 1.0 + dist.high * 0.75 + dist.medium * 0.5 + dist.low * 0.25) / total;
  const freqBonus = Math.min(Math.log10(total + 1), 1.0);
  return Math.min(weighted * (0.5 + 0.5 * freqBonus), 1.0);
}
