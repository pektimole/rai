/**
 * google-grants.ts -- Pure logic for the OAuth Grant Watcher (RAI Phase C).
 *
 * Detects AI-tool OAuth grants on myaccount.google.com/connections, classifies
 * scope-overreach risk, and produces a diff against the previously seen baseline.
 *
 * No DOM, no Chrome APIs -- safe to unit-test in node.
 *
 * Spec: 28-rai-actiongate-spec.md surface adapter `native-messaging-host`,
 * Phase C entry in OL-140.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single OAuth grant observed on the connections page. */
export interface ObservedGrant {
  /** Lowercase app name as displayed by Google (best-effort extracted). */
  name: string;
  /** Optional display label as observed (preserves capitalization for UI). */
  display?: string;
  /** Best-effort scope tags inferred from app description text. */
  scopes: ScopeTag[];
  /** When this grant was first observed locally (ISO-8601). */
  first_seen?: string;
}

export type ScopeTag =
  | 'gmail'
  | 'drive'
  | 'calendar'
  | 'contacts'
  | 'youtube'
  | 'photos'
  | 'docs'
  | 'sheets'
  | 'unknown';

/** A grant + its risk classification. */
export interface ClassifiedGrant extends ObservedGrant {
  ai_vendor: boolean;
  /** Vendor key matched (lowercase). Empty if not classified as AI. */
  ai_vendor_key: string;
  /**
   * High when an AI vendor has a high-impact scope (gmail/drive/calendar full).
   * Medium for other AI grants. Low for non-AI or unknown.
   */
  risk: 'low' | 'medium' | 'high';
}

/** A change between two observation snapshots. */
export interface GrantDiff {
  added: ClassifiedGrant[];
  removed: ClassifiedGrant[];
  /**
   * Existing grants whose scope set changed between snapshots.
   * Useful when an app upgrades from read-only to full-access.
   */
  scope_changed: Array<{
    grant: ClassifiedGrant;
    added_scopes: ScopeTag[];
    removed_scopes: ScopeTag[];
  }>;
}

// ---------------------------------------------------------------------------
// AI vendor classifier
// ---------------------------------------------------------------------------

/**
 * Lowercase substring matchers. Order matters: longer/more-specific matches
 * are checked first so "google ai studio" wins over "google".
 *
 * Conservative bias: only well-known AI surfaces. False negatives are
 * acceptable (extension is permissive and just won't tag); false positives
 * (e.g. matching "claude" inside an unrelated app) are worse, so the
 * matchers are word-boundary-aware where it matters.
 */
const AI_VENDOR_MATCHERS: Array<{ key: string; pattern: RegExp }> = [
  { key: 'google-ai-studio', pattern: /\bgoogle ai studio\b/i },
  { key: 'openai', pattern: /\b(openai|chatgpt)\b/i },
  { key: 'anthropic', pattern: /\b(anthropic|claude)\b/i },
  { key: 'perplexity', pattern: /\bperplexity\b/i },
  { key: 'mistral', pattern: /\bmistral\b/i },
  { key: 'cohere', pattern: /\bcohere\b/i },
  { key: 'gemini', pattern: /\bgemini\b/i },
  { key: 'context', pattern: /\bcontext(\.ai)?\b/i },
  { key: 'granola', pattern: /\bgranola\b/i },
  { key: 'spark', pattern: /\bspark(\s+mail)?\b/i },
  { key: 'otter', pattern: /\botter(\.ai)?\b/i },
  { key: 'fireflies', pattern: /\bfireflies\b/i },
  { key: 'fathom', pattern: /\bfathom\b/i },
  { key: 'tactiq', pattern: /\btactiq\b/i },
  { key: 'notion-ai', pattern: /\bnotion\s+ai\b/i },
  { key: 'monica', pattern: /\bmonica\b/i },
  { key: 'copilot', pattern: /\bcopilot\b/i },
  { key: 'cursor', pattern: /\bcursor\b/i },
  { key: 'codeium', pattern: /\bcodeium\b/i },
  { key: 'replit', pattern: /\breplit\b/i },
  { key: 'meeting-ai', pattern: /\b(meetgeek|read\.ai|grain|krisp|fellow|loopin)\b/i },
];

export function classifyAiVendor(name: string): { isAi: boolean; key: string } {
  for (const { key, pattern } of AI_VENDOR_MATCHERS) {
    if (pattern.test(name)) return { isAi: true, key };
  }
  return { isAi: false, key: '' };
}

// ---------------------------------------------------------------------------
// Scope inference (heuristic from text)
// ---------------------------------------------------------------------------

/**
 * Infer scope tags from a free-text description of an app's permissions.
 * Google's connections page shows lines like "See and download all your Gmail
 * data" or "View and manage your calendars" — we keyword-match on those.
 *
 * Permissive: returns ['unknown'] when nothing matches, so a grant is never
 * dropped silently. Caller can surface the raw text for the user to read.
 */
export function inferScopes(text: string): ScopeTag[] {
  const t = text.toLowerCase();
  const tags = new Set<ScopeTag>();

  if (/\bgmail\b/.test(t) || /\bemail\b/.test(t) || /\bmessages?\b/.test(t)) tags.add('gmail');
  if (/\bdrive\b/.test(t) || /\bfiles?\b/.test(t)) tags.add('drive');
  if (/\bcalendars?\b/.test(t) || /\bevents?\b/.test(t)) tags.add('calendar');
  if (/\bcontacts?\b/.test(t)) tags.add('contacts');
  if (/\byoutube\b/.test(t)) tags.add('youtube');
  if (/\bphotos?\b/.test(t)) tags.add('photos');
  if (/\bdocs?\b/.test(t) || /\bdocuments?\b/.test(t)) tags.add('docs');
  if (/\bsheets?\b/.test(t) || /\bspreadsheets?\b/.test(t)) tags.add('sheets');

  return tags.size === 0 ? ['unknown'] : Array.from(tags);
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

/** Scopes that count as high-impact when held by an AI vendor. */
const HIGH_IMPACT_SCOPES = new Set<ScopeTag>([
  'gmail',
  'drive',
  'calendar',
  'contacts',
]);

export function classifyRisk(
  isAi: boolean,
  scopes: ScopeTag[],
): ClassifiedGrant['risk'] {
  if (!isAi) return 'low';
  if (scopes.some((s) => HIGH_IMPACT_SCOPES.has(s))) return 'high';
  return 'medium';
}

export function classify(grant: ObservedGrant): ClassifiedGrant {
  const { isAi, key } = classifyAiVendor(grant.name);
  return {
    ...grant,
    ai_vendor: isAi,
    ai_vendor_key: key,
    risk: classifyRisk(isAi, grant.scopes),
  };
}

// ---------------------------------------------------------------------------
// Diff against a previous snapshot
// ---------------------------------------------------------------------------

/**
 * Produce a diff between two snapshots. Grants are matched by `name`.
 *
 * - `added`: present in `current` but not in `previous`.
 * - `removed`: present in `previous` but not in `current`.
 * - `scope_changed`: same name, different scope set.
 *
 * All output entries are classified — callers don't need to re-run classify.
 */
export function diffSnapshots(
  previous: ObservedGrant[],
  current: ObservedGrant[],
): GrantDiff {
  const prevByName = new Map(previous.map((g) => [g.name, g]));
  const currByName = new Map(current.map((g) => [g.name, g]));

  const added: ClassifiedGrant[] = [];
  const removed: ClassifiedGrant[] = [];
  const scope_changed: GrantDiff['scope_changed'] = [];

  for (const [name, g] of currByName) {
    if (!prevByName.has(name)) {
      added.push(classify(g));
      continue;
    }
    const prev = prevByName.get(name)!;
    const prevScopes = new Set(prev.scopes);
    const currScopes = new Set(g.scopes);
    const addedScopes = [...currScopes].filter((s) => !prevScopes.has(s));
    const removedScopes = [...prevScopes].filter((s) => !currScopes.has(s));
    if (addedScopes.length || removedScopes.length) {
      scope_changed.push({
        grant: classify(g),
        added_scopes: addedScopes,
        removed_scopes: removedScopes,
      });
    }
  }

  for (const [name, g] of prevByName) {
    if (!currByName.has(name)) removed.push(classify(g));
  }

  return { added, removed, scope_changed };
}

/**
 * Pull just the high-priority items from a diff (new AI vendors with
 * sensitive scopes, scope upgrades on existing AI vendors). This is the
 * subset that warrants user-facing notification; the rest goes to the audit
 * log only.
 */
export function notifiableFromDiff(diff: GrantDiff): ClassifiedGrant[] {
  const out: ClassifiedGrant[] = [];
  for (const g of diff.added) {
    if (g.ai_vendor) out.push(g);
  }
  for (const c of diff.scope_changed) {
    if (
      c.grant.ai_vendor &&
      c.added_scopes.some((s) => HIGH_IMPACT_SCOPES.has(s))
    ) {
      out.push(c.grant);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot normaliser
// ---------------------------------------------------------------------------

/**
 * Normalise an array of raw observed entries into a deduped, sorted snapshot.
 * Names are lowercased and trimmed; scope arrays are deduped + sorted.
 * Empty names are dropped.
 */
export function normaliseSnapshot(raw: ObservedGrant[]): ObservedGrant[] {
  const byName = new Map<string, ObservedGrant>();
  for (const g of raw) {
    const name = (g.name ?? '').trim().toLowerCase();
    if (!name) continue;
    const scopes = Array.from(new Set(g.scopes ?? [])).sort() as ScopeTag[];
    if (!byName.has(name)) {
      byName.set(name, { name, display: g.display ?? g.name, scopes, first_seen: g.first_seen });
    } else {
      // Merge scopes if the same name appears multiple times.
      const existing = byName.get(name)!;
      const merged = Array.from(new Set([...existing.scopes, ...scopes])).sort() as ScopeTag[];
      existing.scopes = merged;
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
