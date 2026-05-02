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
import {
  normaliseSnapshot,
  diffSnapshots,
  notifiableFromDiff,
  inferScopes,
  type ObservedGrant,
  type GrantDiff,
} from '../shared/google-grants.js';

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

// ---------------------------------------------------------------------------
// OAuth Grant Watcher (Phase C) -- handles snapshots from google-grants.ts
// ---------------------------------------------------------------------------

interface GrantsObservedMessage {
  action: 'grants_observed';
  url: string;
  grants: ObservedGrant[];
  ts: string;
}

interface StoredGrantsState {
  grants_baseline?: ObservedGrant[];
  grants_diff_history?: Array<{
    ts: string;
    diff: GrantDiff;
  }>;
  grants_last_seen_ts?: string;
  grants_total_observed?: number;
}

const GRANTS_DIFF_HISTORY_CAP = 20;

function loadGrantsState(): Promise<StoredGrantsState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'grants_baseline',
        'grants_diff_history',
        'grants_last_seen_ts',
        'grants_total_observed',
      ],
      (data) => resolve(data as StoredGrantsState),
    );
  });
}

function setGrantsBadge(tabId: number | undefined, hasNew: boolean): void {
  if (!tabId) return;
  if (hasNew) {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800', tabId });
  }
}

/**
 * Enrich an observed snapshot with scope inference. The content script
 * supplies the bare visible label; here we run inferScopes against the
 * display string so the diff layer can see scope-tag deltas.
 */
function enrichWithScopes(grants: ObservedGrant[]): ObservedGrant[] {
  return grants.map((g) => ({
    ...g,
    scopes: g.scopes.length > 0 ? g.scopes : inferScopes(g.display ?? g.name),
  }));
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if ((message as GrantsObservedMessage).action !== 'grants_observed') return false;

  const m = message as GrantsObservedMessage;
  const tabId = sender.tab?.id;

  void (async () => {
    const enriched = enrichWithScopes(m.grants);
    const current = normaliseSnapshot(enriched);

    const state = await loadGrantsState();
    const previous = normaliseSnapshot(state.grants_baseline ?? []);

    const diff = diffSnapshots(previous, current);
    const notifiable = notifiableFromDiff(diff);

    const hasMeaningfulChange =
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      diff.scope_changed.length > 0;

    const newHistory = [...(state.grants_diff_history ?? [])];
    if (hasMeaningfulChange) {
      newHistory.unshift({ ts: m.ts, diff });
      newHistory.length = Math.min(newHistory.length, GRANTS_DIFF_HISTORY_CAP);
    }

    chrome.storage.local.set({
      grants_baseline: current,
      grants_diff_history: newHistory,
      grants_last_seen_ts: m.ts,
      grants_total_observed: current.length,
    });

    if (notifiable.length > 0) {
      setGrantsBadge(tabId, true);
      console.log(
        '[RAI grants] notifiable:',
        notifiable.map((g) => `${g.ai_vendor_key}(${g.risk})`).join(', '),
      );
      void pushGrantsToTelegram(notifiable);
    }
  })();

  return false;
});

interface TelegramConfig {
  rai_telegram_bot_token?: string;
  rai_telegram_chat_id?: string;
}

async function pushGrantsToTelegram(
  notifiable: Array<{ display?: string; name: string; ai_vendor_key: string; risk: string; scopes: string[] }>,
): Promise<void> {
  const cfg = await new Promise<TelegramConfig>((resolve) => {
    chrome.storage.local.get(
      ['rai_telegram_bot_token', 'rai_telegram_chat_id'],
      (data) => resolve(data as TelegramConfig),
    );
  });
  const token = cfg.rai_telegram_bot_token;
  const chatId = cfg.rai_telegram_chat_id;
  if (!token || !chatId) return;

  const lines = notifiable.map(
    (g) =>
      `· ${g.display ?? g.name} (${g.ai_vendor_key}, ${g.risk}) scopes=${g.scopes.join(',') || 'unknown'}`,
  );
  const text = `RAI · OAuth grant change\n${lines.join('\n')}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.warn('[RAI grants] telegram push failed:', err);
  }
}
