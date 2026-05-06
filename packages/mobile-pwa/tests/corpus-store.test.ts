/**
 * Pure-function tests for the corpus store helpers. The IndexedDB read/write
 * paths (`appendCorpusRow`, `listCorpusRows`, `getJudgmentForScan`) get manual
 * validation on real Android Chrome per `ANDROID-VALIDATION.md`, matching the
 * pattern used for the share-staging code.
 */

import { describe, expect, it } from 'vitest';
import {
  rowsToJsonl,
  sha256Hex,
  type CorpusRow,
} from '../src/corpus/store';

describe('rowsToJsonl', () => {
  it('returns an empty string when there are no rows', () => {
    expect(rowsToJsonl([])).toBe('');
  });

  it('emits one row per line with a trailing newline', () => {
    const rows: CorpusRow[] = [
      {
        type: 'scan',
        scan_id: 'a',
        ts: '2026-05-06T00:00:00.000Z',
        source: 'mobile-pwa',
        content: 'hello',
        content_hash: 'sha256:abc',
        verdict: 'clean',
        confidence: 0.95,
        signals: [],
        explanation: 'No threat signals detected.',
        p1_invoked: false,
        ocr_confidence: 0.9,
      },
      {
        type: 'judgment',
        scan_id: 'a',
        ts: '2026-05-06T00:00:01.000Z',
        judgment: 'agree',
      },
    ];
    const jsonl = rowsToJsonl(rows);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'scan', scan_id: 'a' });
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'judgment', judgment: 'agree' });
  });

  it('preserves all required scan fields end-to-end', () => {
    const row: CorpusRow = {
      type: 'scan',
      scan_id: 'xyz',
      ts: '2026-05-06T00:00:00.000Z',
      source: 'mobile-pwa',
      content: 'flagged content',
      content_hash: 'sha256:deadbeef',
      verdict: 'flagged',
      confidence: 0.7,
      signals: [
        { layer: 'L1', label: 'fake-insight-framing', signal: 'fake-insight-framing', severity: 'low' },
      ],
      explanation: 'AI provenance fingerprint detected.',
      p1_invoked: true,
      p1_model: 'claude-haiku-4-5-20251001',
      p1_latency_ms: 812,
      ocr_confidence: 0.88,
      source_url: 'https://www.linkedin.com/posts/abc',
      page_title: 'Some post',
    };
    const parsed = JSON.parse(rowsToJsonl([row]).trim());
    expect(parsed).toEqual(row);
  });
});

describe('sha256Hex', () => {
  it('returns the canonical SHA-256 hex of the input', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches a known fixture for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for unicode payloads', async () => {
    const a = await sha256Hex('hello world 👋');
    const b = await sha256Hex('hello world 👋');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});
