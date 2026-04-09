// Load stats and settings
chrome.storage.local.get(
  ['scan_count', 'threats_detected', 'strict_mode', 'anthropic_api_key'],
  (data) => {
    const d = data as {
      scan_count?: number;
      threats_detected?: number;
      strict_mode?: boolean;
      anthropic_api_key?: string;
    };
    const scans = document.getElementById('scans');
    const threats = document.getElementById('threats');
    const toggle = document.getElementById('strict-toggle') as HTMLInputElement | null;

    if (scans) scans.textContent = String(d.scan_count || 0);
    if (threats) threats.textContent = String(d.threats_detected || 0);
    if (toggle) toggle.checked = d.strict_mode ?? false;

    // API key state
    updateApiKeyUI(!!d.anthropic_api_key);
  },
);

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
