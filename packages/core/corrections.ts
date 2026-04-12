/**
 * corrections.ts — RAI correction detection + recording
 *
 * Two correction sources:
 *   1. Cross-tier contradiction: P1 contradicts P0, or P2 contradicts P1.
 *      Detected automatically when both tiers scan the same message.
 *   2. User override: user dismisses a verdict or escalates a clean scan.
 *      Called from extension popup, NanoClaw command, or API.
 *
 * User overrides get 3x sample weight (same as OL-104 ambient feed).
 * Cross-tier corrections get 1x.
 */

import { getDefaultScanLog } from './scan-log.js';
import type { CorrectionEntry, ScanTier } from './scan-log.js';
import { shouldRetrain, retrain } from './phantom.js';

// ---------------------------------------------------------------------------
// Cross-tier contradiction detection
// ---------------------------------------------------------------------------

/**
 * Compare P0 and P1 verdicts for the same scan_id.
 * If they disagree, log a correction against the less authoritative tier.
 * P1 is more authoritative than P0 (Claude vs regex).
 */
export function detectP0P1Contradiction(
  scanId: string,
  p0Verdict: string,
  p1Verdict: string,
): CorrectionEntry | null {
  // No contradiction
  if (p0Verdict === p1Verdict) return null;

  // P1 clean but P0 blocked/flagged = P0 was too aggressive (false positive)
  // P1 blocked but P0 clean = P0 missed it (false negative)
  const correction: CorrectionEntry = {
    timestamp: new Date().toISOString(),
    scan_id: scanId,
    corrected_tier: 'p0',
    corrected_verdict: p1Verdict, // P1 is the "truth" for this correction
    correction_source: 'cross_tier',
    contradicting_tier: 'p1',
    reason: `P1 verdict "${p1Verdict}" contradicts P0 verdict "${p0Verdict}"`,
    sample_weight: 1.0,
  };

  getDefaultScanLog().logCorrection(correction);
  maybeRetrain();
  return correction;
}

/**
 * Compare P1 and P2 verdicts for the same scan_id.
 * P2 (multi-agent consensus) is more authoritative than P1.
 */
export function detectP1P2Contradiction(
  scanId: string,
  p1Verdict: string,
  p2ConsensusVerdict: string,
): CorrectionEntry | null {
  // Map P2 consensus verdicts to P1-comparable verdicts
  const p2Simplified =
    p2ConsensusVerdict === 'confirmed_threat' || p2ConsensusVerdict === 'likely_threat'
      ? 'flagged'
      : p2ConsensusVerdict === 'false_positive' || p2ConsensusVerdict === 'likely_safe'
        ? 'clean'
        : null; // uncertain = no correction signal

  if (p2Simplified === null || p2Simplified === p1Verdict) return null;

  const correction: CorrectionEntry = {
    timestamp: new Date().toISOString(),
    scan_id: scanId,
    corrected_tier: 'p1',
    corrected_verdict: p2Simplified,
    correction_source: 'cross_tier',
    contradicting_tier: 'p2',
    reason: `P2 consensus "${p2ConsensusVerdict}" contradicts P1 verdict "${p1Verdict}"`,
    sample_weight: 1.0,
  };

  getDefaultScanLog().logCorrection(correction);
  maybeRetrain();
  return correction;
}

// ---------------------------------------------------------------------------
// User override
// ---------------------------------------------------------------------------

export interface UserOverride {
  /** The scan_id of the verdict being corrected. */
  scan_id: string;
  /** Which tier produced the verdict the user is overriding. */
  tier: ScanTier;
  /** What the user thinks the correct verdict should be. */
  corrected_verdict: 'clean' | 'flagged' | 'blocked';
  /** Optional reason from user (extension popup, NanoClaw reply). */
  reason?: string;
}

/**
 * Record a user correction. This is the strongest training signal (3x weight).
 * Called from: extension popup "Dismiss" / "Report threat", NanoClaw "@no5 rai override".
 */
export function recordUserOverride(override: UserOverride): CorrectionEntry {
  const correction: CorrectionEntry = {
    timestamp: new Date().toISOString(),
    scan_id: override.scan_id,
    corrected_tier: override.tier,
    corrected_verdict: override.corrected_verdict,
    correction_source: 'user_override',
    reason: override.reason,
    sample_weight: 3.0, // User overrides are the strongest signal
  };

  getDefaultScanLog().logCorrection(correction);
  maybeRetrain();
  return correction;
}

// ---------------------------------------------------------------------------
// Auto-retrain check
// ---------------------------------------------------------------------------

function maybeRetrain(): void {
  if (shouldRetrain()) {
    retrain('threshold');
  }
}
