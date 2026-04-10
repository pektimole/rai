/**
 * RAI Content Script -- Main entry point
 * Injects into AI platform pages, hooks paste/submit/response events.
 *
 * Default (Standard mode): warn on flag, block send on critical. Paste always lands.
 * Strict mode (settings): prevent paste entirely on blocked verdicts.
 */

import { detectPlatform, type PlatformAdapter } from './platforms/platform-registry.js';
import { showOverlay, showSendBlocker, removeSendBlocker } from './overlay.js';
import type { ScanRequest, ScanResponse } from '../shared/types.js';

const MIN_SCAN_LENGTH = 10;

// Current settings (loaded from storage on init)
let strictMode = false;

// Synchronous send block flag -- set by paste/scan, checked by submit hook
let sendBlocked = false;

function loadSettings(): void {
  chrome.storage.local.get(['strict_mode'], (data: { [key: string]: unknown }) => {
    strictMode = (data.strict_mode as boolean) ?? false;
  });
}

// Listen for settings changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.strict_mode) {
    strictMode = (changes.strict_mode.newValue as boolean) ?? false;
  }
});

async function scan(content: string, source: ScanRequest['source']): Promise<ScanResponse | null> {
  if (content.length < MIN_SCAN_LENGTH) return null;

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'scan', content, source, url: location.href } satisfies ScanRequest,
      (response: ScanResponse) => {
        if (chrome.runtime.lastError) {
          console.warn('[RAI] scan failed:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Paste hook
// ---------------------------------------------------------------------------

function hookPaste(adapter: PlatformAdapter): void {
  // beforeinput fires before ProseMirror/Slate — only used in strict mode
  document.addEventListener('beforeinput', (e: InputEvent) => {
    if (!strictMode) return;
    if (e.inputType !== 'insertFromPaste') return;

    const text = e.dataTransfer?.getData('text/plain');
    if (!text || text.length < MIN_SCAN_LENGTH) return;

    // Synchronous block: we can't await here, so we always block in strict mode
    // and then scan async to show the overlay
    e.preventDefault();

    scan(text, 'clipboard').then((result) => {
      if (!result) return;
      const input = adapter.getInputElement();

      if (result.verdict === 'clean') {
        // False block — re-insert the text
        if (input) {
          document.execCommand('insertText', false, text);
        }
      } else {
        showOverlay(result, input ?? undefined);
      }
    });
  }, { capture: true });

  // Standard mode: paste lands, scan async, show warning/block send
  document.addEventListener('paste', async (e: ClipboardEvent) => {
    if (strictMode) return; // handled by beforeinput

    const text = e.clipboardData?.getData('text/plain');
    if (!text || text.length < MIN_SCAN_LENGTH) return;

    const result = await scan(text, 'clipboard');
    if (!result || result.verdict === 'clean') return;

    const input = adapter.getInputElement();

    if (result.verdict === 'blocked') {
      // Standard mode: paste lands, but block the send button
      sendBlocked = true;
      showOverlay(result, input ?? undefined);
      showSendBlocker(adapter, result, () => { sendBlocked = false; });
    } else {
      // Flagged: warn only
      showOverlay(result, input ?? undefined);
    }
  }, { capture: true });
}

// ---------------------------------------------------------------------------
// Submit hook
// ---------------------------------------------------------------------------

function hookSubmit(adapter: PlatformAdapter): void {
  let scanning = false;

  function interceptSubmit(e: Event): void {
    // Synchronous check: if send is blocked, prevent immediately
    if (sendBlocked) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
  }

  // Intercept click on submit button
  document.addEventListener('click', (e) => {
    const btn = adapter.getSubmitButton();
    if (btn && (e.target === btn || btn.contains(e.target as Node))) {
      interceptSubmit(e);
    }
  }, { capture: true });

  // Intercept Enter key in input
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const input = adapter.getInputElement();
      if (input && (e.target === input || input.contains(e.target as Node))) {
        interceptSubmit(e);
      }
    }
  }, { capture: true });
}

// ---------------------------------------------------------------------------
// AI response observer
// ---------------------------------------------------------------------------

function hookResponses(adapter: PlatformAdapter): void {
  const container = adapter.getResponseContainer();
  if (!container) {
    setTimeout(() => hookResponses(adapter), 2000);
    return;
  }

  const scannedNodes = new WeakSet<Node>();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (scannedNodes.has(node)) continue;
        if (!adapter.isResponseNode(node)) continue;

        scannedNodes.add(node);
        const el = node as HTMLElement;

        // Wait for streaming to complete
        setTimeout(async () => {
          const text = adapter.extractResponseText(el);
          if (text.length < MIN_SCAN_LENGTH) return;

          const result = await scan(text, 'ai_response');
          if (!result || result.verdict === 'clean') return;

          showOverlay(result, el);
        }, 1500);
      }
    }
  });

  observer.observe(container, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(): void {
  const adapter = detectPlatform();
  if (!adapter) return;

  loadSettings();
  console.log(`[RAI] Active on ${adapter.name}`);

  hookPaste(adapter);
  hookSubmit(adapter);
  hookResponses(adapter);
  hookP1Upgrades(adapter);
}

// Listen for P1 verdict upgrades from the background service worker.
// P0 verdict arrives synchronously via sendResponse. If P1 later produces
// a higher-severity verdict, it arrives here via tabs.sendMessage.
function hookP1Upgrades(adapter: PlatformAdapter): void {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'scan_upgrade') return;

    const result = message as ScanResponse;
    if (result.verdict === 'clean') return;

    const input = adapter.getInputElement();

    if (result.verdict === 'blocked') {
      sendBlocked = true;
      showOverlay(result, input ?? undefined);
      showSendBlocker(adapter, result, () => { sendBlocked = false; });
    } else if (result.verdict === 'flagged') {
      showOverlay(result, input ?? undefined);
    }
  });
}

init();

// Handle SPA route changes
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    init();
  }
}).observe(document.body, { childList: true, subtree: true });
