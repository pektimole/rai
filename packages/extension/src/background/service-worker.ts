/**
 * RAI Background Service Worker
 * Receives scan requests from content scripts, runs P0, optionally P1 (BYOK).
 *
 * Flow:
 * 1. P0 runs instantly (<5ms), verdict sent immediately
 * 2. If API key exists AND shouldEscalateToP1(): run P1 async, send updated verdict via tabs.sendMessage
 */

import { scanP0 } from '../shared/rai-scan-p0.js';
import { scanP1, shouldEscalateToP1, mergeVerdicts } from '../shared/rai-scan-p1.js';
import type { ScanRequest, ScanResponse } from '../shared/types.js';

// Badge colors
const BADGE_COLORS = {
  clean: '#4CAF50',
  flagged: '#FF9800',
  blocked: '#F44336',
} as const;

function updateBadge(tabId: number | undefined, verdict: ScanResponse['verdict']): void {
  if (!tabId) return;
  if (verdict !== 'clean') {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({
      color: BADGE_COLORS[verdict],
      tabId,
    });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

function updateStats(verdict: ScanResponse['verdict']): void {
  chrome.storage.local.get(['scan_count', 'threats_detected'], (data) => {
    const counts = data as { scan_count?: number; threats_detected?: number };
    chrome.storage.local.set({
      scan_count: (counts.scan_count || 0) + 1,
      threats_detected:
        (counts.threats_detected || 0) + (verdict !== 'clean' ? 1 : 0),
    });
  });
}

chrome.runtime.onMessage.addListener(
  (message: ScanRequest, sender, sendResponse: (response: ScanResponse) => void) => {
    if (message.action !== 'scan') return false;

    const tabId = sender.tab?.id;

    // Step 1: P0 runs synchronously, always returns immediately
    const p0 = scanP0(message.content);

    updateBadge(tabId, p0.verdict);
    updateStats(p0.verdict);

    // Always send P0 verdict immediately (no async delay)
    sendResponse({
      verdict: p0.verdict,
      confidence: p0.confidence,
      threat_layers: p0.threat_layers,
      explanation: p0.explanation,
    });

    // Step 2: P1 runs async in background, sends upgrade via tabs.sendMessage
    chrome.storage.local.get(['anthropic_api_key'], (data) => {
      const apiKey = (data.anthropic_api_key as string) || null;
      if (!apiKey || !shouldEscalateToP1(p0.verdict, p0.confidence)) return;
      if (!tabId) return;

      const p0Patterns = p0.threat_layers.map((t) => t.label);

      scanP1(apiKey, message.content, message.source, p0.verdict, p0Patterns)
        .then((p1) => {
          const merged = mergeVerdicts(p0, p1);

          // Only send upgrade if P1 changed the verdict
          if (merged.verdict !== p0.verdict || merged.confidence !== p0.confidence) {
            updateBadge(tabId, merged.verdict);
            updateStats(merged.verdict);

            // Send P1 upgrade to content script
            chrome.tabs.sendMessage(tabId, {
              action: 'scan_upgrade',
              verdict: merged.verdict,
              confidence: merged.confidence,
              threat_layers: merged.threat_layers,
              explanation: merged.explanation,
              p1_invoked: true,
              p1_latency_ms: p1.latency_ms,
              p1_model: p1.model_used,
            } satisfies ScanResponse & { action: string });
          }
        })
        .catch((err) => {
          console.error('[RAI P1] background scan failed:', err);
          // Fail open: P0 verdict already sent
        });
    });

    return false; // Response already sent synchronously
  },
);

// Clear badge when navigating to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId });
  }
});
