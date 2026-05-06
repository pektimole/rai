/**
 * Mobile PWA entry. Pipeline:
 *   1. Pick up a pending share from IndexedDB if /?share=<id> is present.
 *   2. OCR the staged image with Tesseract.js.
 *   3. Run P0 (always) then P1 (when BYOK key present + escalation criteria
 *      met) against the OCR'd text.
 *   4. Persist the scan row to the IDB corpus store and render the verdict
 *      pill, signals, label keyboard, and meta line into #latest-scan.
 *   5. Wire the 3-button label keyboard, BYOK save/clear, and JSONL export.
 *   6. Listen on BroadcastChannel for in-flight messages from the SW.
 */

import { takePendingShare } from './share/staging';
import { recognizeText, type OcrResult } from './ocr/recognize';
import { scanP0 } from './scanner/rai-scan-p0';
import { scanP1, shouldEscalateToP1, mergeVerdicts } from './scanner/rai-scan-p1';
import {
  clearAnthropicKey,
  getAnthropicKey,
  setAnthropicKey,
} from './scanner/byok';
import {
  appendCorpusRow,
  getCorpusCounts,
  getJudgmentForScan,
  listCorpusRows,
  rowsToJsonl,
  sha256Hex,
  type JudgmentRow,
  type ScanRow,
} from './corpus/store';
import type { PendingShare } from './share/extract';
import type { ScanResult } from './scanner/types';
import type { P1Result } from './scanner/rai-scan-p1';
import { renderApp, type ViewState } from './ui/render';

const SW_CHANNEL = 'rai-mobile';
const STATUS_TOKENS = new Set(['pending', 'empty', 'error']);

let viewState: ViewState = {
  latest: null,
  counts: { scans: 0, judgments: 0 },
  hasApiKey: false,
};

async function refreshAndRender(): Promise<void> {
  viewState = {
    ...viewState,
    counts: await getCorpusCounts(),
    hasApiKey: getAnthropicKey() !== null,
  };
  renderApp(document, viewState);
}

async function setLatestScan(scan: ScanRow | null): Promise<void> {
  if (scan === null) {
    viewState = { ...viewState, latest: null };
  } else {
    const judgment = await getJudgmentForScan(scan.scan_id);
    viewState = { ...viewState, latest: { scan, judgment } };
  }
  renderApp(document, viewState);
}

async function buildScanRow(
  pending: PendingShare,
  ocr: OcrResult,
  p0: ScanResult,
  p1: P1Result | null,
): Promise<ScanRow> {
  const merged = p1 ? mergeVerdicts(p0, p1) : null;
  const verdict = merged?.verdict ?? p0.verdict;
  const confidence = merged?.confidence ?? p0.confidence;
  const signals = merged?.threat_layers ?? p0.threat_layers;
  const explanation = merged?.explanation ?? p0.explanation;
  const content_hash = `sha256:${await sha256Hex(ocr.text)}`;

  return {
    type: 'scan',
    scan_id: p0.scan_id,
    ts: new Date().toISOString(),
    source: 'mobile-pwa',
    content: ocr.text,
    content_hash,
    verdict,
    confidence,
    signals,
    explanation,
    p1_invoked: p1 !== null,
    p1_model: p1?.model_used,
    p1_latency_ms: p1?.latency_ms,
    ocr_confidence: ocr.ocr_confidence,
    source_url: pending.source_url,
    page_title: pending.title,
  };
}

async function runPipeline(pending: PendingShare): Promise<void> {
  const ocr = await recognizeText(pending.image);
  console.log('[rai-mobile] ocr', {
    chars: ocr.text.length,
    word_count: ocr.word_count,
    raw_word_count: ocr.raw_word_count,
    dropped_low_confidence: ocr.dropped_low_confidence,
    ocr_confidence: Number(ocr.ocr_confidence.toFixed(3)),
    duration_ms: ocr.duration_ms,
    preview: ocr.text.slice(0, 200),
  });

  if (ocr.text.length === 0) {
    console.warn('[rai-mobile] OCR produced empty text, skipping scan');
    return;
  }

  const p0 = scanP0(ocr.text);
  console.log('[rai-mobile] p0', {
    scan_id: p0.scan_id,
    verdict: p0.verdict,
    confidence: p0.confidence,
    signals: p0.threat_layers.map((t) => `${t.layer}:${t.label}`),
  });

  let p1: P1Result | null = null;
  const apiKey = getAnthropicKey();
  if (apiKey && shouldEscalateToP1(p0.verdict, p0.confidence)) {
    p1 = await scanP1(
      apiKey,
      ocr.text,
      'share',
      p0.verdict,
      p0.threat_layers.map((t) => t.label),
    );
    console.log('[rai-mobile] p1', {
      scan_id: p0.scan_id,
      model_used: p1.model_used,
      latency_ms: p1.latency_ms,
      verdict: p1.verdict,
      confidence: p1.confidence,
    });
  } else if (!apiKey) {
    console.log('[rai-mobile] p1 skipped: no BYOK key set');
  } else {
    console.log('[rai-mobile] p1 skipped: P0 verdict definitive');
  }

  const scanRow = await buildScanRow(pending, ocr, p0, p1);
  await appendCorpusRow(scanRow);
  await refreshAndRender();
  await setLatestScan(scanRow);
}

async function pickupPendingShare(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const shareParam = params.get('share');
  if (!shareParam) return;

  if (STATUS_TOKENS.has(shareParam)) {
    console.log(`[rai-mobile] share status: ${shareParam}`);
    return;
  }

  try {
    const pending = await takePendingShare(shareParam);
    if (!pending) {
      console.warn('[rai-mobile] no staged share for id', shareParam);
      return;
    }
    console.log('[rai-mobile] pending share picked up', {
      id: pending.id,
      bytes: pending.image.size,
      type: pending.imageType,
      title: pending.title,
      source_url: pending.source_url,
    });

    await runPipeline(pending);
  } catch (err) {
    console.error('[rai-mobile] pipeline failed', err);
  }
}

function attachUiHandlers(): void {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const labelBtn = target.closest<HTMLButtonElement>('.label-btn');
    if (labelBtn?.dataset.judgment) {
      void handleLabelTap(labelBtn.dataset.judgment as JudgmentRow['judgment']);
      return;
    }

    if (target.id === 'byok-save') {
      void handleByokSave();
      return;
    }

    if (target.id === 'byok-clear') {
      handleByokClear();
      return;
    }

    if (target.id === 'export-btn') {
      void handleExport();
      return;
    }

    if (target.id === 'pick-file-btn') {
      const input = document.getElementById('pick-file-input') as HTMLInputElement | null;
      input?.click();
      return;
    }
  });

  const fileInput = document.getElementById('pick-file-input') as HTMLInputElement | null;
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void handleFilePick(file);
    fileInput.value = '';
  });
}

async function handleFilePick(file: File): Promise<void> {
  const button = document.getElementById('pick-file-btn') as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Scanning…';
  }
  try {
    const pending: PendingShare = {
      id: crypto.randomUUID(),
      image: file,
      imageName: file.name || undefined,
      imageType: file.type || 'application/octet-stream',
      receivedAt: Date.now(),
    };
    console.log('[rai-mobile] manual file picked', {
      name: pending.imageName,
      bytes: pending.image.size,
      type: pending.imageType,
    });
    await runPipeline(pending);
  } catch (err) {
    console.error('[rai-mobile] manual scan failed', err);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Pick a screenshot to scan';
    }
  }
}

async function handleLabelTap(
  judgment: JudgmentRow['judgment'],
): Promise<void> {
  if (!viewState.latest || viewState.latest.judgment) return;
  const row: JudgmentRow = {
    type: 'judgment',
    scan_id: viewState.latest.scan.scan_id,
    ts: new Date().toISOString(),
    judgment,
  };
  await appendCorpusRow(row);
  viewState = {
    ...viewState,
    latest: { scan: viewState.latest.scan, judgment: row },
    counts: await getCorpusCounts(),
  };
  renderApp(document, viewState);
}

async function handleByokSave(): Promise<void> {
  const input = document.getElementById('byok-input') as HTMLInputElement | null;
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;
  if (!key.startsWith('sk-ant-')) {
    input.value = '';
    input.placeholder = 'Must start with sk-ant-…';
    input.style.borderColor = '#DC2626';
    return;
  }
  setAnthropicKey(key);
  input.value = '';
  await refreshAndRender();
}

function handleByokClear(): void {
  clearAnthropicKey();
  void refreshAndRender();
}

async function handleExport(): Promise<void> {
  const rows = await listCorpusRows();
  if (rows.length === 0) return;
  const blob = new Blob([rowsToJsonl(rows)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `rai-mobile-corpus-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bootstrap(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!sessionStorage.getItem('rai-mobile-reloaded')) {
        sessionStorage.setItem('rai-mobile-reloaded', '1');
        window.location.reload();
      }
    });
  }
  const channel = new BroadcastChannel(SW_CHANNEL);
  channel.addEventListener('message', (event) => {
    if (event.data?.type === 'scan_complete') {
      console.log('[rai-mobile] scan_complete', event.data);
    }
  });
  attachUiHandlers();
  void refreshAndRender();
  void pickupPendingShare();
}

bootstrap();
