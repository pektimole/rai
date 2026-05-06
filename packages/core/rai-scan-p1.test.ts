/**
 * rai-scan-p1.test.ts -- Regression tests for the P1 system prompt.
 *
 * No live LLM call here -- just static structure checks against the SYSTEM_PROMPT
 * string. Locks in the OL-124 AI-provenance fingerprint classes and the
 * canonical threat layer enumeration so future edits cannot silently drop them.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Read the source rather than importing -- the SYSTEM_PROMPT is module-private.
// This is intentional: the test verifies the prompt as it lives in source.
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

describe('P1 system prompt — canonical threat layer enumeration', () => {
  it('mentions every layer in the canonical schema', () => {
    for (const layer of ['L-2', 'L-1', 'L0', 'L1', 'L2', 'L3']) {
      expect(P1_SOURCE).toContain(`- ${layer}:`);
    }
  });

  it('declares the JSON output schema with all six layers', () => {
    expect(P1_SOURCE).toContain('"L-2" | "L-1" | "L0" | "L1" | "L2" | "L3"');
  });
});

describe('P1 system prompt — OL-124 AI-provenance fingerprint classes', () => {
  it.each(NAMED_PATTERN_CLASSES)(
    'declares "%s" by exact name',
    (className) => {
      expect(P1_SOURCE).toContain(`"${className}"`);
    },
  );

  it('frames L1 as AI-provenance / non-human-generated content', () => {
    expect(P1_SOURCE).toMatch(
      /L1: AI-provenance\s*\/\s*non-human-generated/i,
    );
  });

  it('names the human poster as conduit, not threat', () => {
    expect(P1_SOURCE).toMatch(/conduit,\s*not\s*threat/i);
  });

  it('instructs the model to report the class name in the signal field', () => {
    expect(P1_SOURCE).toMatch(/signal.{0,80}exactly as written/i);
  });

  it('caps AI-provenance fingerprint severity below high (warn, not block)', () => {
    expect(P1_SOURCE).toMatch(
      /AI-provenance fingerprints is typically low or medium/i,
    );
  });
});

describe('P1 system prompt — output JSON contract preserved', () => {
  it('still requires a `verdict` enum of clean | flagged | blocked', () => {
    expect(P1_SOURCE).toContain('"clean" | "flagged" | "blocked"');
  });

  it('still requires a `confidence` 0..1 numeric', () => {
    expect(P1_SOURCE).toContain('"confidence": 0.0-1.0');
  });

  it('still demands JSON only (no preamble)', () => {
    expect(P1_SOURCE).toMatch(/Output ONLY valid JSON/);
  });
});
