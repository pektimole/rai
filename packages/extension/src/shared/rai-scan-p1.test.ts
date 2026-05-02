/**
 * rai-scan-p1.test.ts -- Regression tests for the extension P1 system prompt.
 *
 * Mirrors packages/core/rai-scan-p1.test.ts. The two prompts are intentionally
 * kept in lockstep -- if one drifts, both consumers (NanoClaw + browser) get
 * inconsistent verdicts. These tests lock in the OL-124 pattern classes on
 * the extension side so the next CWS upload can't quietly skip them.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const P1_SOURCE = fs.readFileSync(
  path.join(__dirname, 'rai-scan-p1.ts'),
  'utf-8',
);

const NAMED_PATTERN_CLASSES = [
  'fake-insight-framing',
  'manufactured-urgency',
  'false-consensus',
  'authority-spoofing',
  'overconfidence-absolutes',
];

describe('Extension P1 system prompt — OL-124 pattern classes', () => {
  it.each(NAMED_PATTERN_CLASSES)(
    'declares "%s" by exact name',
    (className) => {
      expect(P1_SOURCE).toContain(`"${className}"`);
    },
  );

  it('frames L1 as Misinformation OR epistemic manipulation', () => {
    expect(P1_SOURCE).toMatch(
      /L1: Misinformation\s*\/\s*epistemic manipulation/i,
    );
  });

  it('instructs the model to report the class name in the signal field', () => {
    expect(P1_SOURCE).toMatch(/signal.{0,80}exactly as written/i);
  });
});

describe('Extension P1 system prompt — output JSON contract preserved', () => {
  it('verdict enum unchanged', () => {
    expect(P1_SOURCE).toContain('"clean" | "flagged" | "blocked"');
  });

  it('confidence range unchanged', () => {
    expect(P1_SOURCE).toContain('"confidence": 0.0-1.0');
  });

  it('demands JSON only', () => {
    expect(P1_SOURCE).toMatch(/Output ONLY valid JSON/);
  });
});
