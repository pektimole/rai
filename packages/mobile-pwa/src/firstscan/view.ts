/**
 * First-scan screen markup (OL-661). Pure: report in, HTML string out, so the
 * same report always renders the same numbers and tests need no DOM.
 *
 * Copy rules: signals not verdicts, received dates always shown, no masked
 * values, no urgency styling (neutral classes only), no "found today" framing.
 */

import type { ThreatLayer } from '../scanner/types';
import { escapeHtml } from '../ui/render';
import { isSecret, type FirstScanReport, type ReportItem } from './report';

const SECRET_NAME = 'Exposed secret';

/** Scanner explanations come from the single-scan flow and end in "Content blocked.". Nothing is blocked here: signals, not verdicts. */
function whyText(s: string): string {
  return s.replace(/\s*(?:Content blocked|Review before sending)\.\s*/g, ' ').replace(/^(?:Infrastructure-level threat|Injection pattern) detected:\s*/, 'Pattern: ').trim();
}

const LAYER_NAMES: Record<ThreatLayer, string> = {
  'L-2': 'Data or system access request',
  'L-1': 'Identity override',
  L0: 'Hidden instruction',
  L1: 'AI-generation signal',
  L2: 'Wider spread risk',
  L3: 'Systemic risk',
};

const day = (iso: string): string => iso.slice(0, 10);
const minute = (iso: string): string => iso.slice(0, 16).replace('T', ' ') + ' UTC';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function headerHtml(r: FirstScanReport): string {
  let range: string;
  if (r.datedCount === 0) {
    range = 'Received dates not available for these items.';
  } else {
    const span = r.oldest === r.newest ? `Received ${day(r.oldest!)}` : `Received ${day(r.oldest!)} to ${day(r.newest!)}`;
    range = r.datedCount === r.itemCount ? span : `${span} (${r.datedCount} of ${r.itemCount} dated)`;
  }
  return `
    <div class="fs-header">
      <div class="fs-title">You shared ${plural(r.itemCount, 'item', 'items')} · scanned ${escapeHtml(minute(r.scannedAt))}</div>
      <div class="fs-range">${escapeHtml(range)}</div>
      ${r.unreadable > 0 ? `<div class="fs-range">${plural(r.unreadable, 'image', 'images')} had no readable text and ${r.unreadable === 1 ? 'was' : 'were'} not scanned.</div>` : ''}
    </div>`;
}

/**
 * The AI box says what was actually checked. P0 has no AI-generation rules; only the deep scan does,
 * and it runs on few items. So: "not checked" when nothing was checked, otherwise "checked k of n". Never a bare 0.
 */
function cardsHtml(r: FirstScanReport, hasKey: boolean): string {
  const total = r.itemCount;
  const ai = r.aiChecked === 0
    ? `<div class="fs-card" data-metric="ai-generation" data-checked="false"><div class="fs-card-n">&mdash;</div><div class="fs-card-l">AI generation not checked.${hasKey ? ' The deep scan did not run on these items.' : ' Add a BYOK key for the deep scan.'}</div></div>`
    : `<div class="fs-card" data-metric="ai-generation" data-checked="${r.aiChecked}"><div class="fs-card-n">${r.aiSignals}</div><div class="fs-card-l">AI-generation signals · checked ${r.aiChecked} of ${total}</div></div>`;
  return `
    <div class="fs-cards">
      ${ai}
      <div class="fs-card" data-metric="hidden-instructions"><div class="fs-card-n">${r.hiddenInstructions}</div><div class="fs-card-l">Hidden instructions</div></div>
      ${r.exposedSecrets > 0 ? `<div class="fs-card" data-metric="exposed-secrets"><div class="fs-card-n">${r.exposedSecrets}</div><div class="fs-card-l">Exposed secrets</div></div>` : ''}
    </div>`;
}

function rowHtml(item: ReportItem): string {
  const received = item.receivedAt ? `received ${day(item.receivedAt)}` : 'received date unknown';
  const meta = [item.source, received].filter((p) => p !== '').join(' · ');
  const signals = item.signals
    .map((s) => {
      const matched = s.matched_pattern ? ` <span class="fs-match">“${escapeHtml(s.matched_pattern)}”</span>` : '';
      return `<li>${escapeHtml(isSecret(s) ? SECRET_NAME : LAYER_NAMES[s.layer])}: ${escapeHtml(s.signal)}${matched}</li>`;
    })
    .join('');
  return `
    <li class="fs-row" data-item="${escapeHtml(item.id)}">
      <div class="fs-what">${escapeHtml(item.what)}</div>
      <div class="fs-meta">${escapeHtml(meta)}</div>
      <div class="fs-tags"><span class="fs-layer">${escapeHtml(item.signals.every(isSecret) ? SECRET_NAME : LAYER_NAMES[item.layer])}</span><span class="fs-conf">confidence ${Math.round(item.confidence * 100)}%</span></div>
      <details class="fs-why"><summary>Why</summary>
        <ul>${signals}</ul>
        ${whyText(item.why) ? `<p>${escapeHtml(whyText(item.why))}</p>` : ''}
      </details>
    </li>`;
}

function cleanRowHtml(n: number): string {
  if (n === 0) return '';
  return `
    <li class="fs-row fs-clean" data-clean-row>${n === 1 ? '1 item shows' : `${n} items show`} no signals</li>`;
}

export function renderFirstScanHtml(r: FirstScanReport, opts: { aiCheck?: boolean } = {}): string {
  const aiCheck = opts.aiCheck ?? true;
  return `
    ${headerHtml(r)}
    ${cardsHtml(r, aiCheck)}
    <ul class="fs-rows">${r.flagged.map(rowHtml).join('')}${cleanRowHtml(r.cleanCount)}</ul>
    <div class="fs-footer">Signals, not verdicts.</div>
    <button type="button" id="fs-keep-watching" class="fs-cta">Keep watching</button>`;
}
