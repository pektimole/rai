/**
 * BS Council merge — canonical regression tests.
 *
 * Anchor case: Shai-Hulud / Turnbull-flip (spec § Acceptance criteria).
 * The pre-BS-Council failure was: P1 first marked the claim "supports a real
 * threat", a verify-request flipped it to "high-confidence false". The fix is
 * the verifiability axis: BS Council must never collapse to "false" when web
 * grounding is unavailable or thin. It downgrades to UNVERIFIED instead.
 */
import { describe, it, expect } from 'vitest';
import { mergeBSVerdicts } from '../bs-council.js';
import type {
  Citation,
  CouncilBreakdownA,
  CouncilBreakdownB,
  CouncilBreakdownC,
  CouncilBreakdownD,
  CredibilityTier,
} from '../types.js';

function cite(
  url: string,
  tier: CredibilityTier,
  supports: Citation['supports'] = 'claim',
): Citation {
  return { url, title: url, source_tier: tier, excerpt: '', supports };
}

function A(verdict: CouncilBreakdownA['verdict'], citations: Citation[] = []): CouncilBreakdownA {
  return { role: 'A', verdict, citations, query: 'q', provider: 'anthropic', model: 'claude-sonnet-4-6' };
}
function B(verdict: CouncilBreakdownB['verdict'], citations: Citation[] = []): CouncilBreakdownB {
  return { role: 'B', verdict, citations, query: 'q', provider: 'together', model: 'Qwen/Qwen3-72B-Instruct' };
}
function C(tier: CouncilBreakdownC['tier'] = 'unknown'): CouncilBreakdownC {
  return { role: 'C', tier, weight: 0.5, reasoning: '', provider: 'registry', model: 'credibility-seed' };
}
function D(verdict: CouncilBreakdownD['verdict'] = 'no_signal'): CouncilBreakdownD {
  return { role: 'D', verdict, reasoning: '', provider: 'ollama', model: 'qwen2.5:14b' };
}

describe('mergeBSVerdicts — canonical rules', () => {
  it('CONFIRMED when A+B support with ≥1 established citation', () => {
    const citations = [
      cite('https://nvd.nist.gov/cve/CVE-2024-99999', 'official'),
      cite('https://github.com/advisories/GHSA-xxxx', 'established'),
    ];
    const result = mergeBSVerdicts({
      scanId: 'scan-confirmed',
      A: A('supports', citations),
      B: B('supports', citations),
      C: C('established'),
      D: D('current'),
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('CONTESTED when A and B disagree', () => {
    const result = mergeBSVerdicts({
      scanId: 'scan-split',
      A: A('supports', [cite('https://nvd.nist.gov/x', 'official')]),
      B: B('contradicts', [cite('https://example.org/debunk', 'established', 'counter')]),
      C: C('established'),
      D: D('current'),
    });
    expect(result.verdict).toBe('CONTESTED');
  });

  it('CONTESTED when both contradict', () => {
    const result = mergeBSVerdicts({
      scanId: 'scan-both-contradict',
      A: A('contradicts', [cite('https://x.com', 'established', 'counter')]),
      B: B('contradicts', [cite('https://y.com', 'established', 'counter')]),
      C: C('established'),
      D: D('current'),
    });
    expect(result.verdict).toBe('CONTESTED');
  });

  it('UNVERIFIED when both no_signal — never collapses to false', () => {
    const result = mergeBSVerdicts({
      scanId: 'scan-no-signal',
      A: A('no_signal'),
      B: B('no_signal'),
      C: C('unknown'),
      D: D('no_signal'),
    });
    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.confidence).toBe(0);
  });

  it('UNVERIFIED when only social-tier citations exist', () => {
    const social = [cite('https://twitter.com/randomuser/status/1', 'social')];
    const result = mergeBSVerdicts({
      scanId: 'scan-low-tier',
      A: A('supports', social),
      B: B('supports', social),
      C: C('social'),
      D: D('no_signal'),
    });
    expect(result.verdict).toBe('UNVERIFIED');
  });

  it('CONTESTED when only one side supports and no established cite', () => {
    const result = mergeBSVerdicts({
      scanId: 'scan-mixed',
      A: A('supports', [cite('https://reddit.com/r/x', 'community')]),
      B: B('no_signal'),
      C: C('community'),
      D: D('no_signal'),
    });
    expect(result.verdict).toBe('CONTESTED');
  });

  it('Temporal demotion: D=superseded drops CONFIRMED → CONTESTED', () => {
    const citations = [cite('https://nvd.nist.gov/x', 'official')];
    const result = mergeBSVerdicts({
      scanId: 'scan-superseded',
      A: A('supports', citations),
      B: B('supports', citations),
      C: C('official'),
      D: D('superseded'),
    });
    expect(result.verdict).toBe('CONTESTED');
  });

  it('Dual-tag FALSE-ALARM when threat axis was wrong AND verifiability CONFIRMED', () => {
    const citations = [cite('https://nvd.nist.gov/x', 'official')];
    const result = mergeBSVerdicts({
      scanId: 'scan-false-alarm',
      A: A('supports', citations),
      B: B('supports', citations),
      C: C('official'),
      D: D('current'),
      threatAxisFlaggedMisinfo: true,
    });
    expect(result.verdict).toBe('FALSE-ALARM');
    expect(result.dual_tag_false_alarm).toBe(true);
  });

  it('No dual-tag when threat axis was right (not flagged misinfo)', () => {
    const citations = [cite('https://nvd.nist.gov/x', 'official')];
    const result = mergeBSVerdicts({
      scanId: 'scan-no-dualtag',
      A: A('supports', citations),
      B: B('supports', citations),
      C: C('official'),
      D: D('current'),
      threatAxisFlaggedMisinfo: false,
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.dual_tag_false_alarm).toBeUndefined();
  });

  it('Confidence respects social-tier-only cap (≤ 0.5)', () => {
    const social = [cite('https://twitter.com/x/status/1', 'social')];
    const result = mergeBSVerdicts({
      scanId: 'scan-cap',
      A: A('supports', social),
      B: B('supports', social),
      C: C('social'),
      D: D('no_signal'),
    });
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });
});

// ────────────────────────────────────────────────────────────
// Turnbull-flip canonical regression — spec § Acceptance criteria
// ────────────────────────────────────────────────────────────
//
// GIVEN  claim "Shai-Hulud Worm: 187 packages, 9.6 CVSS, real"
// WHEN   first scan runs (no grounding available)
// THEN   verdict ≠ "high-confidence false"
//        AND verdict ∈ {CONFIRMED, CONTESTED, UNVERIFIED}
//        AND citations.length > 0 OR verdict = UNVERIFIED

describe('Turnbull-flip regression — Shai-Hulud claim', () => {
  it('Empty grounding → UNVERIFIED, never collapses to a false verdict', () => {
    // Simulates first-scan: Brave returns nothing, Anthropic web_search yields no hits.
    const result = mergeBSVerdicts({
      scanId: 'shai-hulud-cold',
      A: A('no_signal'),
      B: B('no_signal'),
      C: C('unknown'),
      D: D('no_signal'),
    });
    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.verdict).not.toBe('CONFIRMED');
    expect(result.confidence).toBe(0);
  });

  it('Thin social-only grounding → UNVERIFIED, citations preserved for disclosure', () => {
    const cites = [
      cite('https://twitter.com/randomdev/status/1234567890', 'social'),
      cite('https://news.ycombinator.com/item?id=12345', 'social'),
    ];
    const result = mergeBSVerdicts({
      scanId: 'shai-hulud-thin',
      A: A('supports', cites),
      B: B('supports', cites),
      C: C('social'),
      D: D('current'),
    });
    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('Established corroboration on both axes → CONFIRMED', () => {
    const cites = [
      cite('https://nvd.nist.gov/vuln/detail/CVE-2024-99999', 'official'),
      cite('https://github.com/advisories/GHSA-shai-hulud', 'established'),
      cite('https://www.bleepingcomputer.com/news/security/shai-hulud-worm', 'established'),
    ];
    const result = mergeBSVerdicts({
      scanId: 'shai-hulud-corroborated',
      A: A('supports', cites),
      B: B('supports', cites),
      C: C('official'),
      D: D('current'),
    });
    expect(result.verdict).toBe('CONFIRMED');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.citations[0]?.source_tier).toBe('official');
  });

  it('Independent debunk on origin axis (B contradicts) → CONTESTED, not "false"', () => {
    // Agent A still finds support; Agent B traces origin to a hoax site.
    const supporting = [cite('https://medium.com/@blog/post', 'community')];
    const debunking = [cite('https://snopes.com/fact-check/shai-hulud', 'established', 'counter')];
    const result = mergeBSVerdicts({
      scanId: 'shai-hulud-debunk',
      A: A('supports', supporting),
      B: B('contradicts', debunking),
      C: C('established'),
      D: D('current'),
    });
    // BS Council surfaces CONTESTED — UI is expected to render both citations.
    expect(result.verdict).toBe('CONTESTED');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('Across all reasonable input shapes, verdict stays in {CONFIRMED, CONTESTED, UNVERIFIED, FALSE-ALARM}', () => {
    const shapes: Array<{ a: 'supports' | 'contradicts' | 'no_signal'; b: 'supports' | 'contradicts' | 'no_signal' }> = [
      { a: 'supports', b: 'supports' },
      { a: 'supports', b: 'contradicts' },
      { a: 'supports', b: 'no_signal' },
      { a: 'contradicts', b: 'supports' },
      { a: 'contradicts', b: 'contradicts' },
      { a: 'contradicts', b: 'no_signal' },
      { a: 'no_signal', b: 'supports' },
      { a: 'no_signal', b: 'contradicts' },
      { a: 'no_signal', b: 'no_signal' },
    ];
    const allowed = new Set(['CONFIRMED', 'CONTESTED', 'UNVERIFIED', 'FALSE-ALARM']);
    for (const s of shapes) {
      const result = mergeBSVerdicts({
        scanId: `shape-${s.a}-${s.b}`,
        A: A(s.a),
        B: B(s.b),
        C: C('unknown'),
        D: D('no_signal'),
      });
      expect(allowed.has(result.verdict)).toBe(true);
    }
  });
});
