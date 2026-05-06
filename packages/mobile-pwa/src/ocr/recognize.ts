/**
 * Tesseract.js OCR wrapper.
 *
 * One worker per tab, lazy. Caller hands in a Blob (the image staged from the
 * share-sheet); we hand back normalized text plus the metadata the corpus row
 * needs (`ocr_confidence`, raw vs kept word counts, duration).
 *
 * Confidence scale: tesseract.js reports per-word confidence on 0..100.
 * `MIN_WORD_CONFIDENCE` drops obvious noise before the average is computed
 * and before the text is handed to the scanner. The returned `ocr_confidence`
 * is normalized to 0..1 so it lines up with the existing scan-row schema in
 * `docs/29-rai-mobile-spec.md` §7 (`ocr_confidence: 0.88`).
 *
 * Runtime caching for the worker bundle, core wasm, and `eng.traineddata.gz`
 * lives in `sw.ts` (`registerRoute` against the jsDelivr + tessdata CDNs).
 * First OCR pulls them online; subsequent OCRs run from cache.
 */

import { createWorker } from 'tesseract.js';
import type * as Tesseract from 'tesseract.js';

export interface OcrResult {
  text: string;
  ocr_confidence: number;
  word_count: number;
  dropped_low_confidence: number;
  raw_word_count: number;
  duration_ms: number;
}

const MIN_WORD_CONFIDENCE = 50;

let workerPromise: Promise<Tesseract.Worker> | null = null;

function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

export function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

type WordLike = Pick<Tesseract.Word, 'text' | 'confidence'>;
type PageLike = { text?: string; words?: WordLike[] };

export function normalizeOcrPage(page: PageLike): Omit<OcrResult, 'duration_ms'> {
  const allWords = Array.isArray(page.words) ? page.words : [];
  const rawCount = allWords.length;
  const kept = allWords.filter((w) => (w.confidence ?? 0) >= MIN_WORD_CONFIDENCE);
  const dropped = rawCount - kept.length;

  const sourceText =
    typeof page.text === 'string' && page.text.length > 0
      ? page.text
      : kept.map((w) => w.text ?? '').join(' ');
  const text = normalizeWhitespace(sourceText);

  const ocr_confidence =
    kept.length > 0
      ? kept.reduce((acc, w) => acc + (w.confidence ?? 0), 0) / kept.length / 100
      : 0;

  return {
    text,
    ocr_confidence,
    word_count: kept.length,
    dropped_low_confidence: dropped,
    raw_word_count: rawCount,
  };
}

export async function recognizeText(image: Blob): Promise<OcrResult> {
  const worker = await getWorker();
  const start =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const result = await worker.recognize(image);
  const end =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const normalized = normalizeOcrPage(result.data);
  return { ...normalized, duration_ms: Math.round(end - start) };
}

export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const promise = workerPromise;
  workerPromise = null;
  const worker = await promise;
  await worker.terminate();
}

export const __test = { MIN_WORD_CONFIDENCE };
