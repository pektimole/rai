/**
 * RAI Background Service Worker
 * Receives scan requests from content scripts, runs P0, optionally P1 (BYOK).
 *
 * Flow:
 * 1. P0 runs instantly (<5ms)
 * 2. If API key exists AND shouldEscalateToP1(): run P1, return merged verdict
 * 3. Otherwise return P0 verdict
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

function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['anthropic_api_key'], (data) => {
      resolve((data.anthropic_api_key as string) || null);
    });
  });
}

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

    // Run async scan pipeline
    (async () => {
      // Step 1: P0 (instant)
      const p0 = scanP0(message.content);

      // Step 2: Check for P1 escalation
      const apiKey = await getApiKey();
      const shouldP1 = apiKey && shouldEscalateToP1(p0.verdict, p0.confidence);

      if (shouldP1) {
        // Run P1
        const p0Patterns = p0.threat_layers.map((t) => t.label);
        const p1 = await scanP1(
          apiKey,
          message.content,
          message.source,
          p0.verdict,
          p0Patterns,
        );

        // Merge verdicts
        const merged = mergeVerdicts(p0, p1);

        updateBadge(tabId, merged.verdict);
        updateStats(merged.verdict);

        sendResponse({
          verdict: merged.verdict,
          confidence: merged.confidence,
          threat_layers: merged.threat_layers,
          explanation: merged.explanation,
          p1_invoked: true,
          p1_latency_ms: p1.latency_ms,
          p1_model: p1.model_used,
        });
      } else {
        // P0 only
        updateBadge(tabId, p0.verdict);
        updateStats(p0.verdict);

        sendResponse({
          verdict: p0.verdict,
          confidence: p0.confidence,
          threat_layers: p0.threat_layers,
          explanation: p0.explanation,
        });
      }
    })().catch((err) => {
      console.error('[RAI] scan pipeline error:', err);
      // Fail open: return P0 result
      const p0 = scanP0(message.content);
      sendResponse({
        verdict: p0.verdict,
        confidence: p0.confidence,
        threat_layers: p0.threat_layers,
        explanation: p0.explanation,
      });
    });

    return true; // async response
  },
);

// Clear badge when navigating to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId });
  }
});
