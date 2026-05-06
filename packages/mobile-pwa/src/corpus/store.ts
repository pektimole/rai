/**
 * Corpus persistence for the mobile PWA.
 *
 * Two row types live in the same `corpus` IndexedDB store, joined by `scan_id`:
 *   - `scan`: full scan output + content + ocr_confidence + source_url
 *   - `judgment`: user's 3-button label tap (agree / disagree / borderline)
 *
 * Schema deliberately matches `chrome.storage.local.corpus` from the extension
 * + Telegram lab-bot JSONL so a single eval-harness ingest can join them. The
 * five-class derived label is computed at eval time from (verdict, judgment),
 * never stored.
 *
 * `appendCorpusRow` is the only writer. `listCorpusRows` walks the store in
 * insertion order. `getLatestScan` picks the newest scan row from an in-memory
 * scan + reads any matching judgment so the popup-equivalent UI can re-render
 * the label-confirm state on reload.
 */

import {
  openDb,
  CORPUS_STORE,
  CORPUS_SCAN_ID_INDEX,
} from '../db/open';
import type { ThreatSignal, Verdict } from '../scanner/types';

export interface ScanRow {
  type: 'scan';
  scan_id: string;
  ts: string;
  source: 'mobile-pwa';
  content: string;
  content_hash: string;
  verdict: Verdict;
  confidence: number;
  signals: ThreatSignal[];
  explanation: string;
  p1_invoked: boolean;
  p1_model?: string;
  p1_latency_ms?: number;
  ocr_confidence: number;
  source_url?: string;
  page_title?: string;
}

export interface JudgmentRow {
  type: 'judgment';
  scan_id: string;
  ts: string;
  judgment: 'agree' | 'disagree' | 'borderline';
}

export type CorpusRow = ScanRow | JudgmentRow;

export async function appendCorpusRow(row: CorpusRow): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CORPUS_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      tx.objectStore(CORPUS_STORE).add(row);
    });
  } finally {
    db.close();
  }
}

export async function listCorpusRows(): Promise<CorpusRow[]> {
  const db = await openDb();
  try {
    return await new Promise<CorpusRow[]>((resolve, reject) => {
      const tx = db.transaction(CORPUS_STORE, 'readonly');
      const store = tx.objectStore(CORPUS_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []) as CorpusRow[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getCorpusCounts(): Promise<{ scans: number; judgments: number }> {
  const rows = await listCorpusRows();
  return {
    scans: rows.filter((r) => r.type === 'scan').length,
    judgments: rows.filter((r) => r.type === 'judgment').length,
  };
}

export async function getJudgmentForScan(
  scan_id: string,
): Promise<JudgmentRow | null> {
  const db = await openDb();
  try {
    return await new Promise<JudgmentRow | null>((resolve, reject) => {
      const tx = db.transaction(CORPUS_STORE, 'readonly');
      const idx = tx.objectStore(CORPUS_STORE).index(CORPUS_SCAN_ID_INDEX);
      const req = idx.getAll(scan_id);
      req.onsuccess = () => {
        const rows = (req.result ?? []) as CorpusRow[];
        const j = rows.find((r) => r.type === 'judgment') as JudgmentRow | undefined;
        resolve(j ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export function rowsToJsonl(rows: CorpusRow[]): string {
  if (rows.length === 0) return '';
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
