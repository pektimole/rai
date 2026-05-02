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
