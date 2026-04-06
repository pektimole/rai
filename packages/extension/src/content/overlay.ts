/**
 * RAI Warning Overlay -- Shadow DOM isolated banners
 * Renders inline warnings and send blockers when threats are detected.
 */

import type { PlatformAdapter } from './platforms/platform-registry.js';
import type { ScanResponse } from '../shared/types.js';

const OVERLAY_STYLES = `
  .rai-banner {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    line-height: 1.4;
    padding: 10px 14px;
    margin: 8px 0;
    border-radius: 8px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    animation: rai-slide-in 0.2s ease-out;
    z-index: 99999;
    position: relative;
  }
  .rai-banner-block {
    background: #FEE2E2;
    border: 1px solid #FCA5A5;
    color: #991B1B;
  }
  .rai-banner-warn {
    background: #FEF3C7;
    border: 1px solid #FCD34D;
    color: #92400E;
  }
  .rai-icon {
    font-size: 18px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .rai-body {
    flex: 1;
    min-width: 0;
  }
  .rai-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .rai-explanation {
    opacity: 0.85;
  }
  .rai-threats {
    font-size: 12px;
    opacity: 0.7;
    margin-top: 4px;
  }
  .rai-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    opacity: 0.5;
    padding: 0 2px;
    color: inherit;
    flex-shrink: 0;
  }
  .rai-dismiss:hover {
    opacity: 1;
  }
  .rai-send-blocker {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: rgba(153, 27, 27, 0.95);
    color: white;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    animation: rai-slide-up 0.2s ease-out;
  }
  .rai-send-blocker-text {
    flex: 1;
  }
  .rai-send-blocker-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .rai-send-blocker-sub {
    font-size: 12px;
    opacity: 0.8;
  }
  .rai-send-blocker-btn {
    background: rgba(255,255,255,0.2);
    border: 1px solid rgba(255,255,255,0.3);
    color: white;
    padding: 6px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
  .rai-send-blocker-btn:hover {
    background: rgba(255,255,255,0.3);
  }
  .rai-send-blocker-btn-dismiss {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.3);
  }
  @keyframes rai-slide-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes rai-slide-up {
    from { opacity: 0; transform: translateY(-20px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

export function showOverlay(
  result: ScanResponse,
  anchorElement?: HTMLElement,
  autoDismissMs?: number,
): void {
  const host = document.createElement('rai-overlay');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_STYLES;
  shadow.appendChild(style);

  const isBlock = result.verdict === 'blocked';
  const banner = document.createElement('div');
  banner.className = `rai-banner ${isBlock ? 'rai-banner-block' : 'rai-banner-warn'}`;

  const threats = result.threat_layers
    .map((t) => `${t.layer}: ${t.label} (${t.severity})`)
    .join(', ');

  banner.innerHTML = `
    <span class="rai-icon">${isBlock ? '\uD83D\uDEE1\uFE0F' : '\u26A0\uFE0F'}</span>
    <div class="rai-body">
      <div class="rai-title">RAI: ${isBlock ? 'Blocked' : 'Warning'}</div>
      <div class="rai-explanation">${escapeHtml(result.explanation)}</div>
      ${threats ? `<div class="rai-threats">${escapeHtml(threats)}</div>` : ''}
    </div>
    <button class="rai-dismiss" aria-label="Dismiss">\u2715</button>
  `;

  shadow.appendChild(banner);

  const dismissBtn = shadow.querySelector('.rai-dismiss');
  dismissBtn?.addEventListener('click', () => host.remove());

  if (anchorElement?.parentElement) {
    anchorElement.parentElement.insertBefore(host, anchorElement);
  } else {
    document.body.prepend(host);
  }

  // Auto-dismiss warnings (not blocks)
  if (!isBlock) {
    const timeout = autoDismissMs ?? 8000;
    setTimeout(() => host.remove(), timeout);
  }
}

/**
 * Shows a fixed bottom bar that blocks sending.
 * User must acknowledge (dismiss or clear input) before send is re-enabled.
 */
export function showSendBlocker(
  adapter: PlatformAdapter,
  result: ScanResponse,
  onDismiss?: () => void,
): void {
  // Remove any existing blocker
  removeSendBlocker();

  const host = document.createElement('rai-send-blocker');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_STYLES;
  shadow.appendChild(style);

  const blocker = document.createElement('div');
  blocker.className = 'rai-send-blocker';

  blocker.innerHTML = `
    <span class="rai-icon">\uD83D\uDEE1\uFE0F</span>
    <div class="rai-send-blocker-text">
      <div class="rai-send-blocker-title">RAI: Send blocked</div>
      <div class="rai-send-blocker-sub">${escapeHtml(result.explanation)} Clear or edit the content to proceed.</div>
    </div>
    <button class="rai-send-blocker-btn rai-send-blocker-btn-dismiss" data-action="dismiss">I understand the risk</button>
    <button class="rai-send-blocker-btn" data-action="clear">Clear input</button>
  `;

  shadow.appendChild(blocker);

  // "I understand the risk" — dismiss blocker, allow send
  shadow.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
    host.remove();
    removeOverlays();
    onDismiss?.();
  });

  // "Clear input" — wipe the input field and dismiss
  shadow.querySelector('[data-action="clear"]')?.addEventListener('click', () => {
    const input = adapter.getInputElement();
    if (input) {
      if (input instanceof HTMLTextAreaElement) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = '';
        input.innerHTML = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    host.remove();
    removeOverlays();
    onDismiss?.();
  });

  document.body.appendChild(host);
}

export function removeSendBlocker(): void {
  document.querySelectorAll('rai-send-blocker').forEach((el) => el.remove());
}

export function removeOverlays(): void {
  document.querySelectorAll('rai-overlay').forEach((el) => el.remove());
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
