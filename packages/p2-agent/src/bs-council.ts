/**
 * BS Council — verifiability-axis consensus merge.
 * Parallel to mergeVerdicts (threat axis). Spec: docs/26-rai-p2-spec.md.
 *
 * Rules (see spec § Verdict merge logic):
 *  1. A and B both support, ≥1 citation each tier ≥ established → CONFIRMED
 *  2. A and B disagree, OR both contradict → CONTESTED
 *  3. A and B both no_signal, OR all citations tier ≤ social → UNVERIFIED
 *  4. Verdict CONFIRMED + threat-axis previously flagged misinfo → dual-tag FALSE-ALARM
 *  5. Agent D outdated/superseded → demote one tier
 *  6. Agent C feeds citation ranking + confidence, never verdict directly
 */

import type {
  BSCouncilResult,
  BSCouncilVerdict,
  Citation,
  CouncilBreakdownA,
  CouncilBreakdownB,
  CouncilBreakdownC,
  CouncilBreakdownD,
  CredibilityTier,
} from './types.js';

const TIER_RANK: Record<CredibilityTier, number> = {
  official: 4,
  established: 3,
  community: 2,
  social: 1,
  anonymous: 0,
};

const ESTABLISHED_MIN = TIER_RANK.established;
const SOCIAL_MAX = TIER_RANK.social;

const TIER_WEIGHT: Record<CredibilityTier, number> = {
  official: 0.9,
  established: 0.7,
  community: 0.5,
  social: 0.3,
  anonymous: 0.1,
};

export interface MergeBSInput {
  scanId: string;
  A: CouncilBreakdownA;
  B: CouncilBreakdownB;
  C: CouncilBreakdownC;
  D: CouncilBreakdownD;
  threatAxisFlaggedMisinfo?: boolean;
}

export function mergeBSVerdicts(input: MergeBSInput): BSCouncilResult {
  const { scanId, A, B, C, D, threatAxisFlaggedMisinfo } = input;

  const allCitations = dedupeCitations([...A.citations, ...B.citations]);
  const hasEstablishedSupporting = allCitations.some(
    c => c.supports === 'claim' && TIER_RANK[c.source_tier] >= ESTABLISHED_MIN,
  );
  const allLowTier =
    allCitations.length > 0 && allCitations.every(c => TIER_RANK[c.source_tier] <= SOCIAL_MAX);

  let verdict: BSCouncilVerdict;

  if (A.verdict === 'supports' && B.verdict === 'supports' && hasEstablishedSupporting) {
    verdict = 'CONFIRMED';
  } else if (
    (A.verdict === 'supports' && B.verdict === 'contradicts') ||
    (A.verdict === 'contradicts' && B.verdict === 'supports') ||
    (A.verdict === 'contradicts' && B.verdict === 'contradicts')
  ) {
    verdict = 'CONTESTED';
  } else if ((A.verdict === 'no_signal' && B.verdict === 'no_signal') || allLowTier) {
    verdict = 'UNVERIFIED';
  } else {
    // Mixed partial: one supports + one no_signal (or vice versa with contradicts)
    if (A.verdict === 'supports' || B.verdict === 'supports') {
      verdict = hasEstablishedSupporting ? 'CONFIRMED' : 'CONTESTED';
    } else {
      verdict = 'UNVERIFIED';
    }
  }

  // Rule 5: temporal demotion
  if (D.verdict === 'outdated' || D.verdict === 'superseded') {
    verdict = demoteOneTier(verdict);
  }

  // Rule 4: dual-tag FALSE-ALARM when threat axis was wrong
  const dualTag = verdict === 'CONFIRMED' && threatAxisFlaggedMisinfo === true;
  const finalVerdict: BSCouncilVerdict = dualTag ? 'FALSE-ALARM' : verdict;

  const confidence = computeConfidence(allCitations, C, A, B);
  const rankedCitations = rankCitations(allCitations, C);
  const explanation = explain(finalVerdict, A, B, C, D, rankedCitations);

  return {
    scan_id: scanId,
    axis: 'verifiability',
    verdict: finalVerdict,
    confidence,
    agent_breakdown: { A, B, C, D },
    citations: rankedCitations,
    explanation,
    dual_tag_false_alarm: dualTag || undefined,
  };
}

function demoteOneTier(v: BSCouncilVerdict): BSCouncilVerdict {
  if (v === 'CONFIRMED') return 'CONTESTED';
  if (v === 'CONTESTED') return 'UNVERIFIED';
  return v;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

function rankCitations(citations: Citation[], c: CouncilBreakdownC): Citation[] {
  return [...citations].sort((x, y) => {
    const xRank = TIER_RANK[x.source_tier] + (x.supports === 'claim' ? 0.5 : 0);
    const yRank = TIER_RANK[y.source_tier] + (y.supports === 'claim' ? 0.5 : 0);
    return yRank - xRank;
  });
}

function computeConfidence(
  citations: Citation[],
  _c: CouncilBreakdownC,
  a: CouncilBreakdownA,
  b: CouncilBreakdownB,
): number {
  if (citations.length === 0) return 0;
  let support = 0;
  let counter = 0;
  for (const c of citations) {
    const w = TIER_WEIGHT[c.source_tier];
    if (c.supports === 'claim') support += w;
    else if (c.supports === 'counter') counter += w;
  }
  const total = support + counter;
  if (total === 0) return 0;
  const raw = (support - counter) / total;
  // Single low-tier citation cap: never > 0.5 confidence
  const onlyLowTier = citations.every(c => TIER_RANK[c.source_tier] <= SOCIAL_MAX);
  const cap = onlyLowTier ? 0.5 : 1;
  return Math.max(0, Math.min(cap, Math.abs(raw)));
}

function explain(
  verdict: BSCouncilVerdict,
  a: CouncilBreakdownA,
  b: CouncilBreakdownB,
  c: CouncilBreakdownC,
  d: CouncilBreakdownD,
  citations: Citation[],
): string {
  const topCites = citations
    .slice(0, 3)
    .map(x => `${x.source_tier}:${new URL(x.url).hostname}`)
    .join(', ');
  const heads =
    `A(${a.provider}/${a.model})=${a.verdict}, ` +
    `B(${b.provider}/${b.model})=${b.verdict}, ` +
    `C=${c.tier}, D=${d.verdict}`;
  const cites = citations.length > 0 ? ` Citations: ${topCites}.` : ' No citations.';
  return `${verdict}. ${heads}.${cites}`;
}
