/**
 * google-grants.test.ts -- Pure logic tests for the OAuth Grant Watcher.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAiVendor,
  inferScopes,
  classifyRisk,
  classify,
  diffSnapshots,
  notifiableFromDiff,
  normaliseSnapshot,
  type ObservedGrant,
} from './google-grants.js';

describe('classifyAiVendor', () => {
  it('matches Anthropic by Claude', () => {
    const r = classifyAiVendor('Claude (Anthropic)');
    expect(r.isAi).toBe(true);
    expect(r.key).toBe('anthropic');
  });

  it('matches OpenAI via ChatGPT', () => {
    expect(classifyAiVendor('ChatGPT').key).toBe('openai');
  });

  it('matches Granola exactly', () => {
    expect(classifyAiVendor('Granola').key).toBe('granola');
  });

  it('matches Spark Mail', () => {
    expect(classifyAiVendor('Spark Mail').key).toBe('spark');
  });

  it('matches Google AI Studio with priority over plain google', () => {
    const r = classifyAiVendor('Google AI Studio');
    expect(r.key).toBe('google-ai-studio');
  });

  it('does not match plain non-AI apps', () => {
    expect(classifyAiVendor('Dropbox').isAi).toBe(false);
    expect(classifyAiVendor('Slack').isAi).toBe(false);
  });

  it('avoids false positive on substrings without word boundaries', () => {
    // "claudette" embeds "claude" mid-word -> \bclaude\b does NOT match.
    expect(classifyAiVendor('claudette beauty').isAi).toBe(false);
    expect(classifyAiVendor('declaude').isAi).toBe(false);
    // Real word boundary: "Claude (Anthropic)" still matches.
    expect(classifyAiVendor('Claude (Anthropic)').isAi).toBe(true);
  });
});

describe('inferScopes', () => {
  it('detects Gmail scope from natural language', () => {
    expect(inferScopes('See and download all your Gmail data')).toContain('gmail');
  });

  it('detects calendar scope', () => {
    expect(inferScopes('View and manage your calendars')).toContain('calendar');
  });

  it('detects drive scope', () => {
    expect(inferScopes('Access files in your Drive')).toContain('drive');
  });

  it('returns ["unknown"] for empty/non-matching text', () => {
    expect(inferScopes('')).toEqual(['unknown']);
    expect(inferScopes('Random app permission')).toEqual(['unknown']);
  });

  it('detects multiple scopes in one description', () => {
    const r = inferScopes('Read your Gmail and access your Drive files');
    expect(r).toContain('gmail');
    expect(r).toContain('drive');
  });
});

describe('classifyRisk', () => {
  it('low for non-AI', () => {
    expect(classifyRisk(false, ['gmail', 'drive'])).toBe('low');
  });

  it('medium for AI with no high-impact scope', () => {
    expect(classifyRisk(true, ['unknown'])).toBe('medium');
    expect(classifyRisk(true, ['photos'])).toBe('medium');
  });

  it('high for AI with gmail/drive/calendar/contacts', () => {
    expect(classifyRisk(true, ['gmail'])).toBe('high');
    expect(classifyRisk(true, ['drive'])).toBe('high');
    expect(classifyRisk(true, ['calendar'])).toBe('high');
    expect(classifyRisk(true, ['contacts'])).toBe('high');
  });
});

describe('classify', () => {
  it('marks Granola with calendar scope as high risk AI vendor', () => {
    const c = classify({
      name: 'granola',
      scopes: ['calendar'],
    });
    expect(c.ai_vendor).toBe(true);
    expect(c.ai_vendor_key).toBe('granola');
    expect(c.risk).toBe('high');
  });

  it('marks Dropbox as low risk non-AI', () => {
    const c = classify({ name: 'dropbox', scopes: ['drive'] });
    expect(c.ai_vendor).toBe(false);
    expect(c.risk).toBe('low');
  });
});

describe('normaliseSnapshot', () => {
  it('lowercases and dedupes by name, merges scopes', () => {
    const raw: ObservedGrant[] = [
      { name: 'Granola', scopes: ['calendar'] },
      { name: 'granola', scopes: ['contacts'] },
      { name: '   ', scopes: ['gmail'] }, // dropped
    ];
    const out = normaliseSnapshot(raw);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('granola');
    expect(out[0].scopes.sort()).toEqual(['calendar', 'contacts']);
  });

  it('returns a sorted output by name', () => {
    const raw: ObservedGrant[] = [
      { name: 'spark', scopes: [] },
      { name: 'granola', scopes: [] },
      { name: 'claude', scopes: [] },
    ];
    const out = normaliseSnapshot(raw);
    expect(out.map((g) => g.name)).toEqual(['claude', 'granola', 'spark']);
  });
});

describe('diffSnapshots', () => {
  it('detects added grant', () => {
    const prev: ObservedGrant[] = [];
    const curr: ObservedGrant[] = [{ name: 'granola', scopes: ['calendar'] }];
    const d = diffSnapshots(prev, curr);
    expect(d.added).toHaveLength(1);
    expect(d.added[0].name).toBe('granola');
    expect(d.removed).toHaveLength(0);
    expect(d.scope_changed).toHaveLength(0);
  });

  it('detects removed grant', () => {
    const prev: ObservedGrant[] = [{ name: 'spark', scopes: ['gmail'] }];
    const curr: ObservedGrant[] = [];
    const d = diffSnapshots(prev, curr);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0].name).toBe('spark');
  });

  it('detects scope upgrade on existing grant', () => {
    const prev: ObservedGrant[] = [{ name: 'spark', scopes: ['contacts'] }];
    const curr: ObservedGrant[] = [{ name: 'spark', scopes: ['contacts', 'gmail'] }];
    const d = diffSnapshots(prev, curr);
    expect(d.added).toHaveLength(0);
    expect(d.scope_changed).toHaveLength(1);
    expect(d.scope_changed[0].added_scopes).toEqual(['gmail']);
  });

  it('returns empty diff when snapshots match', () => {
    const snap: ObservedGrant[] = [{ name: 'granola', scopes: ['calendar'] }];
    const d = diffSnapshots(snap, snap);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
    expect(d.scope_changed).toHaveLength(0);
  });
});

describe('notifiableFromDiff', () => {
  it('surfaces new AI vendors', () => {
    const diff = diffSnapshots(
      [],
      [{ name: 'granola', scopes: ['calendar'] }],
    );
    const n = notifiableFromDiff(diff);
    expect(n).toHaveLength(1);
    expect(n[0].ai_vendor_key).toBe('granola');
  });

  it('surfaces scope upgrades on AI vendors when high-impact added', () => {
    const diff = diffSnapshots(
      [{ name: 'spark', scopes: ['contacts'] }],
      [{ name: 'spark', scopes: ['contacts', 'gmail'] }],
    );
    const n = notifiableFromDiff(diff);
    expect(n).toHaveLength(1);
  });

  it('does NOT surface non-AI additions', () => {
    const diff = diffSnapshots(
      [],
      [{ name: 'dropbox', scopes: ['drive'] }],
    );
    const n = notifiableFromDiff(diff);
    expect(n).toHaveLength(0);
  });

  it('does NOT surface scope upgrades that only add low-impact scopes', () => {
    const diff = diffSnapshots(
      [{ name: 'granola', scopes: [] }],
      [{ name: 'granola', scopes: ['photos'] }],
    );
    const n = notifiableFromDiff(diff);
    expect(n).toHaveLength(0);
  });
});

describe('Tim audit 2026-04-23 fixtures', () => {
  // Real findings from pektimole@gmail.com OAuth audit on 2026-04-23.
  // Used as a regression fixture to confirm the classifier flags the
  // exact apps Tim flagged in 19-rai-context.md.
  const audit: ObservedGrant[] = [
    { name: 'Spark Mail', scopes: ['gmail', 'calendar'] },
    { name: 'Granola', scopes: ['calendar'] },
    { name: 'Google AI Studio', scopes: ['drive'] },
    { name: 'Dropbox', scopes: ['drive'] },
    { name: 'Slack', scopes: [] },
  ];

  it('classifies all three of Tim\'s flagged apps as high-risk AI', () => {
    const snap = normaliseSnapshot(audit);
    const classified = snap.map(classify);
    const flagged = classified.filter((c) => c.risk === 'high');
    const keys = flagged.map((g) => g.ai_vendor_key).sort();
    expect(keys).toEqual(['google-ai-studio', 'granola', 'spark']);
  });

  it('does not flag Dropbox or Slack', () => {
    const classified = audit.map(classify);
    expect(classified.find((c) => c.name === 'Dropbox')?.ai_vendor).toBe(false);
    expect(classified.find((c) => c.name === 'Slack')?.ai_vendor).toBe(false);
  });
});
