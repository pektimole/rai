/**
 * RAI Background Service Worker
 * Receives scan requests from content scripts, runs P0, returns verdict.
 */

import { scanP0 } from '../shared/rai-scan-p0.js';
import type { ScanRequest, ScanResponse } from '../shared/types.js';

// Badge colors
const BADGE_COLORS = {
  clean: '#4CAF50',
  flagged: '#FF9800',
  blocked: '#F44336',
} as const;

chrome.runtime.onMessage.addListener(
  (message: ScanRequest, sender, sendResponse: (response: ScanResponse) => void) => {
    if (message.action !== 'scan') return false;

    const result = scanP0(message.content);

    // Update badge on the tab
    const tabId = sender.tab?.id;
    if (tabId) {
      if (result.verdict !== 'clean') {
        chrome.action.setBadgeText({ text: '!', tabId });
        chrome.action.setBadgeBackgroundColor({
          color: BADGE_COLORS[result.verdict],
          tabId,
        });
      } else {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    }

    // Update scan stats
    chrome.storage.local.get(['scan_count', 'threats_detected'], (data) => {
      const counts = data as { scan_count?: number; threats_detected?: number };
      chrome.storage.local.set({
        scan_count: (counts.scan_count || 0) + 1,
        threats_detected:
          (counts.threats_detected || 0) + (result.verdict !== 'clean' ? 1 : 0),
      });
    });

    sendResponse({
      verdict: result.verdict,
      confidence: result.confidence,
      threat_layers: result.threat_layers,
      explanation: result.explanation,
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
