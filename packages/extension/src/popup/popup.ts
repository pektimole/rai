chrome.storage.local.get(['scan_count', 'threats_detected', 'strict_mode'], (data) => {
  const d = data as { scan_count?: number; threats_detected?: number; strict_mode?: boolean };
  const scans = document.getElementById('scans');
  const threats = document.getElementById('threats');
  const toggle = document.getElementById('strict-toggle') as HTMLInputElement | null;

  if (scans) scans.textContent = String(d.scan_count || 0);
  if (threats) threats.textContent = String(d.threats_detected || 0);
  if (toggle) toggle.checked = d.strict_mode ?? false;
});

document.getElementById('strict-toggle')?.addEventListener('change', (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ strict_mode: checked });
});
