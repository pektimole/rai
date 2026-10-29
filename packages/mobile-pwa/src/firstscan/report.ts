/**
 * First-scan report (OL-661).
 *
 * Built once from a batch and deep-frozen: the counts shown to the user are the
 * counts that were computed, and nothing recomputes or inflates them later.
 * Detection is not done here; the injected scanner is the existing P0 (+ P1).
 */

import type { ThreatLayer, ThreatSignal } from '../scanner/types';
import type { BatchItem } from './batch';

export interface ItemScan {
  confidence: number;
  signals: ThreatSignal[];
  explanation: string;
}

export type ItemScanner = (item: BatchItem) => Promise<ItemScan>;

export interface ReportItem {
  id: string;
  what: string;
  source: string;
  receivedAt: string | null;
  layer: ThreatLayer;
  confidence: number;
  signals: ThreatSignal[];
  why: string;
}

export interface FirstScanReport {
  itemCount: number;
  datedCount: number;
  oldest: string | null;
  newest: string | null;
  scannedAt: string;
  /** Items with at least one L1 (AI-generation) signal. */
  aiSignals: number;
  /** Items with at least one L0 (hidden instruction) signal. */
  hiddenInstructions: number;
  /** Items with at least one signal, in batch order. */
  flagged: ReportItem[];
  /** Items with no signals, collapsed to a count. */
  cleanCount: number;
  /** Shared images with no readable text. Not scanned, not counted in itemCount. */
  unreadable: number;
}

const SNIPPET_LEN = 160;

/** The layer a row is filed under: hidden instructions first, then AI generation, then the rest. */
function primaryLayer(signals: ThreatSignal[]): ThreatLayer {
  return (
    signals.find((s) => s.layer === 'L0')?.layer ??
    signals.find((s) => s.layer === 'L1')?.layer ??
    signals[0].layer
  );
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LEN ? flat.slice(0, SNIPPET_LEN) + '…' : flat;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export async function buildFirstScan(
  items: readonly BatchItem[],
  scan: ItemScanner,
  now: () => Date = () => new Date(),
  unreadable = 0,
): Promise<FirstScanReport> {
  // Snapshot so later edits to the caller's array or items cannot move the numbers.
  const batch = items.map((i) => ({ ...i }));

  const flagged: ReportItem[] = [];
  let cleanCount = 0;
  let aiSignals = 0;
  let hiddenInstructions = 0;

  for (const item of batch) {
    const result = await scan(item);
    const signals = result.signals.map((s) => ({ ...s }));
    if (signals.length === 0) {
      cleanCount++;
      continue;
    }
    if (signals.some((s) => s.layer === 'L1')) aiSignals++;
    if (signals.some((s) => s.layer === 'L0')) hiddenInstructions++;
    flagged.push({
      id: item.id,
      what: snippet(item.text),
      source: item.source,
      receivedAt: item.receivedAt,
      layer: primaryLayer(signals),
      confidence: result.confidence,
      signals,
      why: result.explanation,
    });
  }

  // Oldest/newest come from item metadata only; undated items are left out of the range.
  const dates = batch.map((i) => i.receivedAt).filter((d): d is string => d !== null).sort();

  return deepFreeze({
    itemCount: batch.length,
    datedCount: dates.length,
    oldest: dates[0] ?? null,
    newest: dates[dates.length - 1] ?? null,
    scannedAt: now().toISOString(),
    aiSignals,
    hiddenInstructions,
    flagged,
    cleanCount,
    unreadable,
  });
}
