/**
 * First-scan screen markup (OL-661). Pure: report in, HTML string out, so the
 * same report always renders the same numbers and tests need no DOM.
 *
 * Copy rules: signals not verdicts, received dates always shown, no masked
 * values, no urgency styling (neutral classes only), no "found today" framing.
 */

import type { ThreatLayer } from '../scanner/types';
import { escapeHtml } from '../ui/render';
import type { FirstScanReport, ReportItem } from './report';

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

function cardsHtml(r: FirstScanReport): string {
  return `
    <div class="fs-cards">
      <div class="fs-card" data-metric="ai-generation"><div class="fs-card-n">${r.aiSignals}</div><div class="fs-card-l">AI-generation signals</div></div>
      <div class="fs-card" data-metric="hidden-instructions"><div class="fs-card-n">${r.hiddenInstructions}</div><div class="fs-card-l">Hidden instructions</div></div>
    </div>`;
}

function rowHtml(item: ReportItem): string {
  const received = item.receivedAt ? `received ${day(item.receivedAt)}` : 'received date unknown';
  const meta = [item.source, received].filter((p) => p !== '').join(' · ');
  const signals = item.signals
    .map((s) => {
      const matched = s.matched_pattern ? ` <span class="fs-match">“${escapeHtml(s.matched_pattern)}”</span>` : '';
      return `<li>${escapeHtml(LAYER_NAMES[s.layer])}: ${escapeHtml(s.signal)}${matched}</li>`;
    })
    .join('');
  return `
    <li class="fs-row" data-item="${escapeHtml(item.id)}">
      <div class="fs-what">${escapeHtml(item.what)}</div>
      <div class="fs-meta">${escapeHtml(meta)}</div>
      <div class="fs-tags"><span class="fs-layer">${escapeHtml(LAYER_NAMES[item.layer])}</span><span class="fs-conf">confidence ${Math.round(item.confidence * 100)}%</span></div>
      <details class="fs-why"><summary>Why</summary>
        <ul>${signals}</ul>
        ${item.why ? `<p>${escapeHtml(item.why)}</p>` : ''}
      </details>
    </li>`;
}

function cleanRowHtml(n: number): string {
  if (n === 0) return '';
  return `
    <li class="fs-row fs-clean" data-clean-row>${n === 1 ? '1 item shows' : `${n} items show`} no signals</li>`;
}

export function renderFirstScanHtml(r: FirstScanReport): string {
  return `
    ${headerHtml(r)}
    ${cardsHtml(r)}
    <ul class="fs-rows">${r.flagged.map(rowHtml).join('')}${cleanRowHtml(r.cleanCount)}</ul>
    <div class="fs-footer">Signals, not verdicts.</div>
    <button type="button" id="fs-keep-watching" class="fs-cta">Keep watching</button>`;
}
