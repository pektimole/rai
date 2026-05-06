interface LatestScanShape {
  scan_id: string;
  ts: string;
  content: string;
  source_url?: string;
  page_title?: string;
  verdict: 'clean' | 'flagged' | 'blocked';
  confidence: number;
  threat_layers: Array<{ layer: string; label: string; signal: string; severity: string }>;
  explanation: string;
  p1_invoked: boolean;
  p1_latency_ms?: number;
  p1_model?: string;
  judgment?: 'agree' | 'disagree' | 'borderline';
}

interface CorpusRowShape {
  type: 'scan' | 'judgment';
  [key: string]: unknown;
}

// Load stats and settings
chrome.storage.local.get(
  [
    'scan_count',
    'threats_detected',
    'strict_mode',
    'anthropic_api_key',
    'grants_baseline',
    'grants_diff_history',
    'grants_last_seen_ts',
    'grants_total_observed',
    'rai_telegram_bot_token',
    'rai_telegram_chat_id',
    'latest_scan',
    'corpus',
  ],
  (data) => {
    const d = data as {
      scan_count?: number;
      threats_detected?: number;
      strict_mode?: boolean;
      anthropic_api_key?: string;
      grants_baseline?: Array<{ name: string; display?: string; scopes: string[] }>;
      grants_diff_history?: Array<{ ts: string; diff: GrantDiffShape }>;
      grants_last_seen_ts?: string;
      grants_total_observed?: number;
      rai_telegram_bot_token?: string;
      rai_telegram_chat_id?: string;
      latest_scan?: LatestScanShape;
      corpus?: CorpusRowShape[];
    };
    const scans = document.getElementById('scans');
    const threats = document.getElementById('threats');
    const toggle = document.getElementById('strict-toggle') as HTMLInputElement | null;

    const scanCount = d.scan_count || 0;
    const threatCount = d.threats_detected || 0;
    const statLine = document.getElementById('stat-line');
    if (statLine) {
      const scanText = `${scanCount} ${scanCount === 1 ? 'scan' : 'scans'}`;
      if (threatCount > 0) {
        statLine.innerHTML = `${scanText} · <span class="threat-count">${threatCount} ${threatCount === 1 ? 'threat' : 'threats'} found</span>`;
      } else {
        statLine.textContent = scanText;
      }
    }
    if (toggle) toggle.checked = d.strict_mode ?? false;

    // API key state
    updateApiKeyUI(!!d.anthropic_api_key);

    // Grants section
    renderGrants({
      total: d.grants_total_observed ?? 0,
      lastSeenTs: d.grants_last_seen_ts,
      history: d.grants_diff_history ?? [],
    });

    // Telegram BYOK state
    updateTelegramUI(!!(d.rai_telegram_bot_token && d.rai_telegram_chat_id));

    // Latest right-click scan
    renderLatestScan(d.latest_scan);
    renderCorpusLine(d.corpus);
  },
);

// Telegram save / clear handlers
document.getElementById('tg-save')?.addEventListener('click', () => {
  const tokenInput = document.getElementById('tg-token') as HTMLInputElement | null;
  const chatInput = document.getElementById('tg-chat-id') as HTMLInputElement | null;
  const token = tokenInput?.value.trim();
  const chat = chatInput?.value.trim();
  if (!token || !chat) return;
  // Basic validation: Telegram tokens are <number>:<base64-ish>
  if (!/^[0-9]+:[A-Za-z0-9_-]{10,}$/.test(token)) {
    if (tokenInput) {
      tokenInput.style.borderColor = '#DC2626';
      tokenInput.value = '';
      tokenInput.placeholder = 'Token shape looks wrong';
    }
    return;
  }
  chrome.storage.local.set(
    { rai_telegram_bot_token: token, rai_telegram_chat_id: chat },
    () => {
      if (tokenInput) tokenInput.value = '';
      if (chatInput) chatInput.value = '';
      updateTelegramUI(true);
    },
  );
});

document.getElementById('tg-clear')?.addEventListener('click', () => {
  chrome.storage.local.remove(
    ['rai_telegram_bot_token', 'rai_telegram_chat_id'],
    () => updateTelegramUI(false),
  );
});

function updateTelegramUI(wired: boolean): void {
  const tokenRow = document.getElementById('tg-input-row');
  const chatRow = document.getElementById('tg-chat-row');
  const activeRow = document.getElementById('tg-active-row');
  if (tokenRow) tokenRow.style.display = wired ? 'none' : 'flex';
  if (chatRow) chatRow.style.display = wired ? 'none' : 'flex';
  if (activeRow) activeRow.style.display = wired ? 'flex' : 'none';
}

interface GrantDiffShape {
  added: Array<{ display?: string; name: string; ai_vendor: boolean; ai_vendor_key: string; risk: string }>;
  removed: Array<{ display?: string; name: string }>;
  scope_changed: Array<{ grant: { display?: string; name: string; ai_vendor_key: string }; added_scopes: string[] }>;
}

function renderGrants(opts: {
  total: number;
  lastSeenTs?: string;
  history: Array<{ ts: string; diff: GrantDiffShape }>;
}): void {
  const section = document.getElementById('grants-section');
  const sub = document.getElementById('grants-sub');
  const list = document.getElementById('grants-list');
  if (!section || !sub || !list) return;

  // Section is always visible (Telegram BYOK lives inside it).
  // Only the list / sub-text reflects whether a baseline has been seen.
  section.style.display = 'block';
  if (opts.total === 0 && opts.history.length === 0) {
    list.innerHTML = '';
    return;
  }

  const lastDate = opts.lastSeenTs ? new Date(opts.lastSeenTs).toLocaleString() : '—';
  sub.textContent = `${opts.total} apps observed · last sync ${lastDate}`;

  // Show top 3 most recent diff items, prioritising AI vendors.
  const items: string[] = [];
  for (const entry of opts.history.slice(0, 5)) {
    for (const a of entry.diff.added) {
      const tag = a.ai_vendor ? '🟠 AI' : '·';
      items.push(`${tag} added: ${a.display ?? a.name}`);
    }
    for (const c of entry.diff.scope_changed) {
      if (c.added_scopes.length === 0) continue;
      items.push(`🟠 ${c.grant.display ?? c.grant.name}: +${c.added_scopes.join(',')}`);
    }
    for (const r of entry.diff.removed) {
      items.push(`· removed: ${r.display ?? r.name}`);
    }
    if (items.length >= 3) break;
  }
  list.innerHTML = items.length ? items.slice(0, 3).map((s) => `<div>${escapeHtml(s)}</div>`).join('') : '<div style="opacity:0.6">No changes since baseline.</div>';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Strict mode toggle
document.getElementById('strict-toggle')?.addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ strict_mode: checked });
});

// API key save
document.getElementById('api-key-save')?.addEventListener('click', () => {
  const input = document.getElementById('api-key') as HTMLInputElement;
  const key = input?.value.trim();
  if (!key) return;

  // Basic validation: must start with sk-ant-
  if (!key.startsWith('sk-ant-')) {
    input.style.borderColor = '#DC2626';
    input.placeholder = 'Must start with sk-ant-...';
    input.value = '';
    return;
  }

  chrome.storage.local.set({ anthropic_api_key: key }, () => {
    input.value = '';
    updateApiKeyUI(true);
  });
});

// API key clear
document.getElementById('api-key-clear')?.addEventListener('click', () => {
  chrome.storage.local.remove('anthropic_api_key', () => {
    updateApiKeyUI(false);
  });
});

function updateApiKeyUI(hasKey: boolean): void {
  const inputRow = document.getElementById('api-key-input-row');
  const activeRow = document.getElementById('api-key-active-row');
  const badge = document.getElementById('p1-badge');
  const footer = document.getElementById('footer-text');

  if (inputRow) inputRow.style.display = hasKey ? 'none' : 'flex';
  if (activeRow) activeRow.style.display = hasKey ? 'flex' : 'none';

  if (badge) {
    badge.textContent = hasKey ? 'P0 + P1' : 'P0 only';
    badge.className = hasKey ? 'p1-badge active' : 'p1-badge';
  }

  if (footer) {
    footer.textContent = hasKey
      ? 'P1 scans use your Anthropic API key.'
      : 'Zero data leaves your device.';
  }
}

// ---------------------------------------------------------------------------
// Latest scan + label buttons + export
// ---------------------------------------------------------------------------

function renderLatestScan(latest: LatestScanShape | undefined): void {
  const empty = document.getElementById('latest-empty');
  const body = document.getElementById('latest-body');
  const verdictPill = document.getElementById('latest-verdict');
  const conf = document.getElementById('latest-conf');
  const content = document.getElementById('latest-content');
  const signals = document.getElementById('latest-signals');
  const explanation = document.getElementById('latest-explanation');
  const labelRow = document.getElementById('label-row');
  const labelConfirm = document.getElementById('label-confirm');
  const meta = document.getElementById('latest-meta');

  if (!latest) {
    if (empty) empty.style.display = 'block';
    if (body) body.style.display = 'none';
    if (verdictPill) {
      verdictPill.textContent = '—';
      verdictPill.className = 'latest-verdict-pill';
    }
    if (conf) conf.textContent = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (body) body.style.display = 'block';

  if (verdictPill) {
    verdictPill.textContent = latest.verdict;
    verdictPill.className = `latest-verdict-pill ${latest.verdict}`;
  }
  if (conf) conf.textContent = `conf ${latest.confidence.toFixed(2)}`;
  if (content) {
    const snippet = latest.content.length > 240 ? latest.content.slice(0, 240) + '…' : latest.content;
    content.textContent = snippet;
  }
  if (signals) {
    if (latest.threat_layers.length === 0) {
      signals.innerHTML = '<div style="opacity:0.6">No signals.</div>';
    } else {
      signals.innerHTML = latest.threat_layers
        .map(
          (t) =>
            `<div class="latest-signal-row"><span class="latest-signal-layer">${escapeHtml(t.layer)}</span><span>${escapeHtml(t.signal)} <span style="color:#999;font-size:10px">(${escapeHtml(t.severity)})</span></span></div>`,
        )
        .join('');
    }
  }
  if (explanation) {
    explanation.textContent = latest.explanation || '';
    explanation.style.display = latest.explanation ? 'block' : 'none';
  }
  if (meta) {
    const parts: string[] = [];
    parts.push(new Date(latest.ts).toLocaleString());
    if (latest.p1_invoked && latest.p1_model && latest.p1_model !== 'none') {
      parts.push(`P1 ${latest.p1_model.replace('claude-', '').split('-')[0]} ${latest.p1_latency_ms}ms`);
    } else {
      parts.push('P0 only');
    }
    if (latest.page_title) parts.push(latest.page_title);
    meta.textContent = parts.join(' · ');
  }

  if (latest.judgment) {
    if (labelRow) labelRow.style.display = 'none';
    if (labelConfirm) {
      labelConfirm.style.display = 'block';
      labelConfirm.textContent = `✓ labelled: ${latest.judgment}`;
    }
  } else {
    if (labelRow) labelRow.style.display = 'flex';
    if (labelConfirm) labelConfirm.style.display = 'none';
  }
}

function renderCorpusLine(corpus: CorpusRowShape[] | undefined): void {
  const line = document.getElementById('corpus-line');
  if (!line) return;
  const rows = corpus ?? [];
  const scans = rows.filter((r) => r.type === 'scan').length;
  const judgments = rows.filter((r) => r.type === 'judgment').length;
  if (scans === 0 && judgments === 0) {
    line.textContent = '';
    return;
  }
  line.textContent = `${scans} scan${scans === 1 ? '' : 's'} · ${judgments} label${judgments === 1 ? '' : 's'} stored locally`;
}

document.querySelectorAll<HTMLButtonElement>('#label-row .label-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const judgment = btn.dataset.judgment as 'agree' | 'disagree' | 'borderline' | undefined;
    if (!judgment) return;
    chrome.storage.local.get(['latest_scan'], (data) => {
      const latest = (data.latest_scan as LatestScanShape | undefined) ?? undefined;
      if (!latest) return;
      chrome.runtime.sendMessage(
        { action: 'rai_label_latest', scan_id: latest.scan_id, judgment },
        () => {
          chrome.storage.local.get(['latest_scan', 'corpus'], (d2) => {
            renderLatestScan(d2.latest_scan as LatestScanShape | undefined);
            renderCorpusLine(d2.corpus as CorpusRowShape[] | undefined);
          });
        },
      );
    });
  });
});

document.getElementById('export-corpus-btn')?.addEventListener('click', () => {
  chrome.storage.local.get(['corpus'], (data) => {
    const rows = (data.corpus as CorpusRowShape[] | undefined) ?? [];
    const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `rai-labelled-corpus-${stamp}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

// Live-update latest scan view if storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.latest_scan) {
    renderLatestScan(changes.latest_scan.newValue as LatestScanShape | undefined);
  }
  if (changes.corpus) {
    renderCorpusLine(changes.corpus.newValue as CorpusRowShape[] | undefined);
  }
});
