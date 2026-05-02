/**
 * google-grants.ts -- Content script for the OAuth Grant Watcher (Phase C).
 *
 * Runs only on https://myaccount.google.com/connections* . Scrapes the visible
 * app list, sends the candidate set to the background service worker, which
 * diffs it against the user's stored baseline and updates the badge / surfaces
 * a notification on new AI-tool grants with sensitive scope.
 *
 * Defensive parser: Google's page uses heavy dynamic content + obfuscated
 * class names. We try several selectors, then fall back to a permissive scan
 * over accessible roles. Over-collection is fine -- the classifier in
 * `shared/google-grants` filters non-AI noise.
 *
 * No side effects on the page beyond reading. Never modifies DOM.
 */

import type { ObservedGrant, ScopeTag } from '../shared/google-grants.js';

const SCAN_DEBOUNCE_MS = 1500;
const CONNECTIONS_PATH_RE = /^\/connections\b/;

let scanScheduled: ReturnType<typeof setTimeout> | null = null;

function shouldRunHere(): boolean {
  if (location.host !== 'myaccount.google.com') return false;
  return CONNECTIONS_PATH_RE.test(location.pathname);
}

// ---------------------------------------------------------------------------
// Scrapers (best-effort, multiple strategies)
// ---------------------------------------------------------------------------

interface RawCandidate {
  name: string;
  description?: string;
}

/**
 * Strategy 1: anchor links to connections/overview/<id> (most stable).
 * Verified against real Google DOM 2026-04-29: every app row is an
 * `<a href="connections/overview/AcBx...">` with the app name as the
 * anchor's textContent. Keeps the older speculative patterns as fallback
 * in case Google has multiple route shapes.
 */
function scrapeByConnectionLinks(): RawCandidate[] {
  const out: RawCandidate[] = [];
  const links = document.querySelectorAll<HTMLAnchorElement>(
    'a[href*="connections/overview"], a[href*="/connections/link"], a[href*="/connections/app"], a[data-provider-index]',
  );
  for (const a of links) {
    const text = (a.textContent ?? '').trim();
    if (!text) continue;
    out.push({ name: text });
  }
  return out;
}

/** Strategy 2: items inside a list role with aria-labels. */
function scrapeByListRole(): RawCandidate[] {
  const out: RawCandidate[] = [];
  const items = document.querySelectorAll<HTMLElement>(
    '[role="list"] [role="listitem"], [role="list"] [role="link"], [role="list"] [role="button"]',
  );
  for (const it of items) {
    const label =
      (it.getAttribute('aria-label') ?? '').trim() ||
      (it.textContent ?? '').trim();
    if (!label) continue;
    out.push({ name: label });
  }
  return out;
}

/** Strategy 3 (fallback): all clickable rows that look like app entries. */
function scrapeByPermissiveRoles(): RawCandidate[] {
  const out: RawCandidate[] = [];
  const items = document.querySelectorAll<HTMLElement>(
    '[role="link"], [role="button"]',
  );
  for (const it of items) {
    const label =
      (it.getAttribute('aria-label') ?? '').trim() ||
      (it.textContent ?? '').trim();
    if (!label || label.length < 2 || label.length > 80) continue;
    // Drop obvious chrome strings that aren't app names.
    if (/^(menu|search|help|sign in|sign out|google account|main menu)$/i.test(label)) continue;
    out.push({ name: label });
  }
  return out;
}

function dedupeByName(candidates: RawCandidate[]): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const c of candidates) {
    const key = c.name.trim().toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, c);
  }
  return Array.from(seen.values());
}

/**
 * Run the strategies in order, prefer the first one that yields >= 1 result.
 * If everything yields nothing, return an empty list (the background will
 * leave the previous baseline untouched).
 */
function scrapeCandidates(): RawCandidate[] {
  const strategies: Array<() => RawCandidate[]> = [
    scrapeByConnectionLinks,
    scrapeByListRole,
    scrapeByPermissiveRoles,
  ];
  for (const fn of strategies) {
    const r = dedupeByName(fn());
    if (r.length > 0) return r;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Snapshot extraction
// ---------------------------------------------------------------------------

/**
 * Convert raw candidates into ObservedGrant[]. Scope inference happens in
 * the background using `inferScopes` -- the content script just supplies
 * the visible label and a description (if available). Empty scopes here
 * means the background will treat the grant as scope=['unknown'] until a
 * subsequent scrape catches more text.
 */
function toObservedGrants(raw: RawCandidate[]): ObservedGrant[] {
  return raw.map((c) => ({
    name: c.name.trim().toLowerCase(),
    display: c.name.trim(),
    scopes: [] as ScopeTag[],
  }));
}

// ---------------------------------------------------------------------------
// Send to background
// ---------------------------------------------------------------------------

function sendSnapshot(grants: ObservedGrant[]): void {
  if (grants.length === 0) return;
  chrome.runtime.sendMessage(
    {
      action: 'grants_observed',
      url: location.href,
      grants,
      ts: new Date().toISOString(),
    },
    () => {
      // Suppress disconnected-port errors that can fire on SPA tear-down.
      if (chrome.runtime.lastError) {
        // intentionally swallowed
      }
    },
  );
}

function scheduleScan(): void {
  if (scanScheduled) clearTimeout(scanScheduled);
  scanScheduled = setTimeout(() => {
    scanScheduled = null;
    if (!shouldRunHere()) return;
    const raw = scrapeCandidates();
    if (raw.length === 0) return;
    sendSnapshot(toObservedGrants(raw));
  }, SCAN_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Init -- observe DOM until content stabilises, then send
// ---------------------------------------------------------------------------

function init(): void {
  if (!shouldRunHere()) return;
  console.log('[RAI grants] active on connections page');

  scheduleScan();

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// SPA route changes: re-init if the path changes
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    init();
  }
}, 1000);
