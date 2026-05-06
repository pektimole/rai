/**
 * DOM rendering for the mobile PWA shell.
 *
 * Stateless render functions: take the latest scan + corpus stats + BYOK
 * presence and write them into the existing markup. Event wiring lives in
 * `main.ts` so this module stays pure-string-and-DOM.
 */

import type { ScanRow, JudgmentRow } from '../corpus/store';

export interface ViewState {
  latest: { scan: ScanRow; judgment: JudgmentRow | null } | null;
  counts: { scans: number; judgments: number };
  hasApiKey: boolean;
}

export function renderApp(root: ParentNode, state: ViewState): void {
  renderHeaderBadge(root, state.hasApiKey);
  renderEmptyState(root, state.latest === null);
  renderLatestScan(root, state.latest);
  renderCorpusLine(root, state.counts);
  renderByok(root, state.hasApiKey);
  renderFooter(root, state.hasApiKey);
}

function renderHeaderBadge(root: ParentNode, hasApiKey: boolean): void {
  const badge = root.querySelector<HTMLElement>('#p1-badge');
  if (!badge) return;
  badge.textContent = hasApiKey ? 'P0 + P1' : 'P0 only';
  badge.classList.toggle('active', hasApiKey);
}

function renderEmptyState(root: ParentNode, show: boolean): void {
  const empty = root.querySelector<HTMLElement>('#empty-state');
  if (empty) empty.hidden = !show;
}

function renderLatestScan(
  root: ParentNode,
  latest: ViewState['latest'],
): void {
  const section = root.querySelector<HTMLElement>('#latest-scan');
  if (!section) return;
  if (!latest) {
    section.hidden = true;
    section.innerHTML = '';
    return;
  }
  section.hidden = false;
  const { scan, judgment } = latest;

  const snippet =
    scan.content.length > 320 ? scan.content.slice(0, 320) + '…' : scan.content;
  const meta = buildMetaLine(scan);
  const signalsHtml = renderSignals(scan.signals);

  section.innerHTML = `
    <div class="latest-card-header">
      <span class="verdict-pill verdict-${scan.verdict}">${escapeHtml(scan.verdict)}</span>
      <span class="latest-conf">conf ${scan.confidence.toFixed(2)}</span>
    </div>
    <div class="latest-content">${escapeHtml(snippet)}</div>
    <div class="latest-signals">${signalsHtml}</div>
    ${scan.explanation ? `<div class="latest-explanation">${escapeHtml(scan.explanation)}</div>` : ''}
    ${renderLabelControls(judgment)}
    <div class="latest-meta">${escapeHtml(meta)}</div>
  `;
}

function renderSignals(signals: ScanRow['signals']): string {
  if (signals.length === 0) {
    return '<div class="signals-empty">No signals.</div>';
  }
  return signals
    .map(
      (t) =>
        `<div class="signal-row"><span class="signal-layer">${escapeHtml(t.layer)}</span><span class="signal-body">${escapeHtml(t.signal)}<span class="signal-severity">(${escapeHtml(t.severity)})</span></span></div>`,
    )
    .join('');
}

function renderLabelControls(judgment: JudgmentRow | null): string {
  if (judgment) {
    return `<div class="label-confirm">✓ labelled: ${escapeHtml(judgment.judgment)}</div>`;
  }
  return `
    <div class="label-row">
      <button class="label-btn" type="button" data-judgment="agree">👍 agree</button>
      <button class="label-btn" type="button" data-judgment="disagree">👎 disagree</button>
      <button class="label-btn" type="button" data-judgment="borderline">🤷 borderline</button>
    </div>
  `;
}

function buildMetaLine(scan: ScanRow): string {
  const parts: string[] = [];
  parts.push(new Date(scan.ts).toLocaleString());
  if (scan.p1_invoked && scan.p1_model && scan.p1_model !== 'none') {
    const modelTag = scan.p1_model.replace('claude-', '').split('-')[0];
    parts.push(`P1 ${modelTag} ${scan.p1_latency_ms ?? 0}ms`);
  } else {
    parts.push('P0 only');
  }
  parts.push(`OCR ${scan.ocr_confidence.toFixed(2)}`);
  if (scan.source_url) parts.push(scan.source_url);
  return parts.join(' · ');
}

function renderCorpusLine(
  root: ParentNode,
  counts: ViewState['counts'],
): void {
  const line = root.querySelector<HTMLElement>('#corpus-line');
  if (!line) return;
  if (counts.scans === 0 && counts.judgments === 0) {
    line.textContent = '';
    return;
  }
  const s = counts.scans;
  const j = counts.judgments;
  line.textContent = `${s} scan${s === 1 ? '' : 's'} · ${j} label${j === 1 ? '' : 's'} stored locally`;
}

function renderByok(root: ParentNode, hasApiKey: boolean): void {
  const section = root.querySelector<HTMLElement>('#byok');
  if (!section) return;
  section.innerHTML = `
    <div class="byok-label">Claude API Key (BYOK)</div>
    <div class="byok-sub">Enables P1 deep scan via your own Anthropic key. Stored on this device only.</div>
    <div class="byok-input-row" ${hasApiKey ? 'hidden' : ''}>
      <input type="password" id="byok-input" placeholder="sk-ant-..." autocomplete="off" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button type="button" id="byok-save">Save</button>
    </div>
    <div class="byok-active-row" ${hasApiKey ? '' : 'hidden'}>
      <span class="byok-status">Key saved locally. P1 active.</span>
      <button type="button" id="byok-clear" class="byok-clear-btn">Remove</button>
    </div>
  `;
}

function renderFooter(root: ParentNode, hasApiKey: boolean): void {
  const footer = root.querySelector<HTMLElement>('#footer-line');
  if (!footer) return;
  footer.textContent = hasApiKey
    ? 'P1 scans use your Anthropic API key. P0 always runs locally.'
    : 'Zero data leaves your device. Add a key for L1 AI-provenance scans.';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
