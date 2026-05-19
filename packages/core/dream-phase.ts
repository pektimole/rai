/**
 * dream-phase.ts — RAI Network Architecture: Phase 1 offline distillation
 *
 * Reads the RAI scan log, aggregates (layer, label) hit frequency + severity,
 * then writes updated ThreatSignatures to the Private Layer store.
 *
 * Phase 1 scope: private-only. No network, no community pool, no crypto.
 * Phase 2 will add: differential privacy, community pool sync, opt-in consent.
 *
 * Invocation:
 *   - Programmatic: await runDreamPhase({ scanLog, privateLayer, since })
 *   - CLI (Stop hook): npx tsx packages/core/dream-phase.ts --auto
 *       --auto  silent when no new entries; prints JSON when work was done
 *
 * Stop hook behaviour (--auto):
 *   1. Read scan log
 *   2. If no entries since last dream-phase → exit 0, no disk write
 *   3. Otherwise: distil, update private layer, print JSON result
 */

import { randomUUID } from 'crypto';
import { getDefaultScanLog, type ScanLog, type ScanLogEntry } from './scan-log.js';
import { getDefaultPrivateLayer, type PrivateLayer } from './private-layer.js';
import {
  signatureId,
  computeConfidence,
  type ThreatSignature,
  type ThreatLayer,
  type Severity,
} from './threat-signature.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DreamPhaseResult {
  run_id: string;
  started_at: string;
  completed_at: string;
  scans_processed: number;
  signatures_created: number;
  signatures_updated: number;
  /** "layer:label" strings for newly seen (layer, label) pairs */
  new_patterns: string[];
}

export interface DreamPhaseOptions {
  scanLog?: ScanLog;
  privateLayer?: PrivateLayer;
  /**
   * ISO timestamp. Only scan entries strictly after this time are processed.
   * Defaults to privateLayer.getLastDreamPhase() (i.e. incremental by default).
   * Pass undefined explicitly to force a full reprocessing of the entire log.
   */
  since?: string | null;
}

// ---------------------------------------------------------------------------
// Core distillation (exported for testing)
// ---------------------------------------------------------------------------

interface SigAccumulator {
  layer: ThreatLayer;
  label: string;
  first_seen: string;
  last_seen: string;
  severity_distribution: Record<Severity, number>;
  surfaces: Set<string>;
}

function channelToSurface(channel: string): string {
  if (channel === 'browser' || channel === 'input') return 'browser_extension';
  if (channel === 'share' || channel === 'file') return 'mobile_pwa';
  return 'nanoclaw';
}

/**
 * Aggregate scan log entries into per-(layer,label) accumulators.
 * Entries with timestamp <= since are skipped (strict greater-than filter).
 */
export function distillScanLog(
  entries: ScanLogEntry[],
  since?: string,
): Map<string, SigAccumulator> {
  const acc = new Map<string, SigAccumulator>();

  for (const entry of entries) {
    if (since && entry.timestamp <= since) continue;

    for (const tl of entry.threat_layers) {
      const id = signatureId(tl.layer as ThreatLayer, tl.label);
      const sev = tl.severity as Severity;
      const existing = acc.get(id);

      const surface = entry.surface ?? channelToSurface(entry.channel);

      if (!existing) {
        const dist: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
        dist[sev] = 1;
        acc.set(id, {
          layer: tl.layer as ThreatLayer,
          label: tl.label,
          first_seen: entry.timestamp,
          last_seen: entry.timestamp,
          severity_distribution: dist,
          surfaces: new Set([surface]),
        });
      } else {
        existing.severity_distribution[sev] =
          (existing.severity_distribution[sev] ?? 0) + 1;
        if (entry.timestamp > existing.last_seen) existing.last_seen = entry.timestamp;
        if (entry.timestamp < existing.first_seen) existing.first_seen = entry.timestamp;
        existing.surfaces.add(surface);
      }
    }
  }

  return acc;
}

// ---------------------------------------------------------------------------
// Main distillation runner
// ---------------------------------------------------------------------------

export async function runDreamPhase(
  options: DreamPhaseOptions = {},
): Promise<DreamPhaseResult> {
  const started_at = new Date().toISOString();
  const run_id = randomUUID();

  const scanLog = options.scanLog ?? getDefaultScanLog();
  const pl = options.privateLayer ?? getDefaultPrivateLayer();

  // Determine since: caller-override > last dream phase > full history
  const since =
    options.since !== undefined
      ? (options.since ?? undefined)
      : (pl.getLastDreamPhase() ?? undefined);

  const allEntries = scanLog.readScans();
  const newEntries = since
    ? allEntries.filter((e) => e.timestamp > since)
    : allEntries;

  // Nothing to do — return early without touching the store
  if (newEntries.length === 0) {
    return {
      run_id,
      started_at,
      completed_at: new Date().toISOString(),
      scans_processed: 0,
      signatures_created: 0,
      signatures_updated: 0,
      new_patterns: [],
    };
  }

  const accumulated = distillScanLog(allEntries, since);

  let created = 0;
  let updated = 0;
  const newPatterns: string[] = [];

  for (const [id, accum] of accumulated) {
    const existing = pl.getSignature(id);
    const newTotal = Object.values(accum.severity_distribution).reduce(
      (a, b) => a + b,
      0,
    );

    if (!existing) {
      const sig: ThreatSignature = {
        id,
        version: 1,
        layer: accum.layer,
        label: accum.label,
        pattern_hint: `${accum.layer}:${accum.label}`,
        sample_count: newTotal,
        confidence: computeConfidence(accum.severity_distribution),
        first_seen: accum.first_seen,
        last_seen: accum.last_seen,
        source: 'private',
        severity_distribution: accum.severity_distribution,
        surfaces_observed: [...accum.surfaces],
      };
      pl.upsertSignature(sig);
      created++;
      newPatterns.push(`${accum.layer}:${accum.label}`);
    } else {
      const merged: Record<Severity, number> = {
        low: existing.severity_distribution.low + accum.severity_distribution.low,
        medium:
          existing.severity_distribution.medium + accum.severity_distribution.medium,
        high: existing.severity_distribution.high + accum.severity_distribution.high,
        critical:
          existing.severity_distribution.critical + accum.severity_distribution.critical,
      };
      const mergedSurfaces = Array.from(
        new Set([...(existing.surfaces_observed ?? []), ...accum.surfaces]),
      );
      const updatedSig: ThreatSignature = {
        ...existing,
        version: existing.version + 1,
        sample_count: existing.sample_count + newTotal,
        confidence: computeConfidence(merged),
        last_seen:
          accum.last_seen > existing.last_seen ? accum.last_seen : existing.last_seen,
        severity_distribution: merged,
        surfaces_observed: mergedSurfaces,
      };
      pl.upsertSignature(updatedSig);
      updated++;
    }
  }

  pl.recordDreamPhase();

  return {
    run_id,
    started_at,
    completed_at: new Date().toISOString(),
    scans_processed: newEntries.length,
    signatures_created: created,
    signatures_updated: updated,
    new_patterns: newPatterns,
  };
}

// ---------------------------------------------------------------------------
// CLI entry — invoked by Stop hook: npx tsx dream-phase.ts --auto
// ---------------------------------------------------------------------------

// Guard: only run when executed directly, not when imported as a module.
const runningAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('dream-phase.ts') ||
    process.argv[1].endsWith('dream-phase.js'));

if (runningAsCli) {
  const auto = process.argv.includes('--auto');

  runDreamPhase()
    .then((result) => {
      // --auto: silent when nothing was processed (fast path for Stop hook)
      if (!auto || result.scans_processed > 0) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[dream-phase] error: ${msg}\n`);
      process.exit(1);
    });
}
