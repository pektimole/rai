/**
 * Gate 1 — Verify-Before-Verdict trigger detector.
 *
 * Decides whether a P1-scanned payload contains a verifiable factual claim
 * that warrants BS Council activation. Conservative by design: false positives
 * cost API spend and latency.
 *
 * Triggers (any-of):
 *   - CVE identifier present
 *   - P1 flagged an L1 (misinfo / AI-provenance) threat at medium+ severity
 *   - Breaking-news framing ("breaking", "just reported", "developing")
 *   - Dated statistic (percentage / dollar figure / count) within 80 chars of a year
 *   - Named-entity action verb (capitalized multi-word + disclosed/attacked/announced/released)
 *
 * Spec: docs/26-rai-p2-spec.md § Two-Gate Protocol § Gate 1.
 */

export type Gate1Reason =
  | 'cve'
  | 'p1-l1-misinfo'
  | 'breaking'
  | 'dated-statistic'
  | 'named-entity-action';

export interface Gate1Input {
  content: string;
  threat_layers?: Array<{ layer: string; severity?: string }>;
  verdict?: 'clean' | 'flagged' | 'blocked';
}

export interface Gate1Output {
  trigger: boolean;
  reasons: Gate1Reason[];
  claim: string;
}

const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/i;
const BREAKING_RE = /\b(breaking|just reported|just announced|developing story|in the last hour|moments ago)\b/i;
const STAT_RE = /(\$[\d,.]+\s*(?:billion|million|thousand|k|m|b)?|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*%|\d+x)/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const NAMED_ACTION_RE = /\b[A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+){0,3}\s+(?:disclosed|announced|released|attacked|breached|patched|deprecated|acquired|launched|reported|confirmed|denied)\b/;

const MID_SEVERITIES = new Set(['medium', 'high', 'critical']);

export function shouldRunBSCouncil(input: Gate1Input): Gate1Output {
  const reasons: Gate1Reason[] = [];
  const text = input.content ?? '';

  if (CVE_RE.test(text)) reasons.push('cve');

  if (input.threat_layers?.some(t => t.layer === 'L1' && MID_SEVERITIES.has(t.severity ?? 'medium'))) {
    reasons.push('p1-l1-misinfo');
  }

  if (BREAKING_RE.test(text)) reasons.push('breaking');

  if (hasDatedStatistic(text)) reasons.push('dated-statistic');

  if (NAMED_ACTION_RE.test(text)) reasons.push('named-entity-action');

  return {
    trigger: reasons.length > 0,
    reasons,
    claim: extractVerifiableClaim(text, reasons),
  };
}

function hasDatedStatistic(text: string): boolean {
  const statMatch = STAT_RE.exec(text);
  if (!statMatch) return false;
  const idx = statMatch.index;
  const window = text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + 80));
  return YEAR_RE.test(window);
}

/**
 * Extracts the salient claim sentence for council prompting. If a triggering
 * pattern is present, returns the sentence containing the first match;
 * otherwise returns the first 280 chars trimmed at a sentence boundary.
 */
export function extractVerifiableClaim(text: string, reasons: Gate1Reason[] = []): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';

  const anchorRe = pickAnchor(reasons);
  if (anchorRe) {
    const match = anchorRe.exec(trimmed);
    if (match) {
      const sentence = sentenceAround(trimmed, match.index);
      if (sentence) return sentence;
    }
  }

  return firstSentenceOrCap(trimmed, 500);
}

function pickAnchor(reasons: Gate1Reason[]): RegExp | null {
  if (reasons.includes('cve')) return CVE_RE;
  if (reasons.includes('named-entity-action')) return NAMED_ACTION_RE;
  if (reasons.includes('breaking')) return BREAKING_RE;
  if (reasons.includes('dated-statistic')) return STAT_RE;
  return null;
}

function sentenceAround(text: string, idx: number): string | null {
  const before = text.lastIndexOf('.', idx);
  const start = before === -1 ? 0 : before + 1;
  const after = text.indexOf('.', idx);
  const end = after === -1 ? Math.min(text.length, idx + 280) : after + 1;
  return text.slice(start, end).trim() || null;
}

function firstSentenceOrCap(text: string, cap: number): string {
  const period = text.indexOf('.');
  if (period !== -1 && period < cap) return text.slice(0, period + 1);
  return text.length <= cap ? text : text.slice(0, cap);
}
