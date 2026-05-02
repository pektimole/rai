/**
 * action-gate-native-messaging-host.test.ts — NMH adapter tests
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateNativeMessagingHost,
  normaliseEvent,
  extractExtensionId,
  defaultNmhPolicy,
  actionSummary,
  syntheticScanId,
  type NativeMessagingHostAction,
  type NativeMessagingHostPolicy,
  type VcceWatchEvent,
} from './action-gate-native-messaging-host';

const ANTHROPIC_ORIGINS = [
  'chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/',
  'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/',
  'chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/',
];

function anthropicAction(
  overrides: Partial<NativeMessagingHostAction> = {},
): NativeMessagingHostAction {
  return {
    kind: 'native-messaging-host-manifest',
    event: 'baseline',
    os: 'macos',
    browser: 'chromium',
    path: '/Users/ich/Library/Application Support/Chromium/NativeMessagingHosts/com.anthropic.claude_browser_extension.json',
    vendor: 'com.anthropic.claude_browser_extension',
    binary_path: '/Applications/Claude.app/Contents/Helpers/chrome-native-host',
    host_type: 'stdio',
    allowed_origins: [...ANTHROPIC_ORIGINS],
    sha256: 'e47dd53d0af4f77de8ddf4d22bec9a77416fda7a2329c51f055fc56877af52b6',
    ...overrides,
  };
}

describe('extractExtensionId', () => {
  it('parses a well-formed origin', () => {
    expect(
      extractExtensionId('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/'),
    ).toBe('fcoeoabgfenejglbffodgkkbkcdhcgfn');
  });

  it('parses without trailing slash', () => {
    expect(
      extractExtensionId('chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn'),
    ).toBe('fcoeoabgfenejglbffodgkkbkcdhcgfn');
  });

  it('returns null for non-chrome-extension origins', () => {
    expect(extractExtensionId('https://example.com/')).toBeNull();
  });

  it('returns null for malformed IDs (wrong length)', () => {
    expect(extractExtensionId('chrome-extension://tooshort/')).toBeNull();
  });
});

describe('normaliseEvent', () => {
  it('maps a baseline event into an action', () => {
    const raw: VcceWatchEvent = {
      ts: '2026-04-22T20:00:00Z',
      event: 'baseline',
      browser: 'chromium',
      path: '/Users/ich/Library/Application Support/Chromium/NativeMessagingHosts/com.anthropic.claude_browser_extension.json',
      vendor: 'com.anthropic.claude_browser_extension',
      binary: '/Applications/Claude.app/Contents/Helpers/chrome-native-host',
      host_type: 'stdio',
      allowed_origins: ANTHROPIC_ORIGINS,
      sha256: 'abc123',
    };
    const action = normaliseEvent(raw);
    expect(action).not.toBeNull();
    expect(action?.vendor).toBe('com.anthropic.claude_browser_extension');
    expect(action?.os).toBe('macos');
    expect(action?.event).toBe('baseline');
  });

  it('returns null for heartbeat', () => {
    expect(normaliseEvent({ ts: 't', event: 'heartbeat' })).toBeNull();
  });

  it('returns null for parse_error', () => {
    expect(
      normaliseEvent({
        ts: 't',
        event: 'modified',
        path: '/x',
        sha256: 'x',
        parse_error: true,
      }),
    ).toBeNull();
  });

  it('returns null for removed events (handled separately by runner)', () => {
    expect(
      normaliseEvent({ ts: 't', event: 'removed', path: '/x' }),
    ).toBeNull();
  });

  it('computes allowed_origins_diff when previous is supplied', () => {
    const raw: VcceWatchEvent = {
      ts: 't',
      event: 'modified',
      browser: 'chromium',
      path: '/x/chromium/NativeMessagingHosts/com.foo.json',
      vendor: 'com.foo',
      binary: '/Applications/Foo.app/bin',
      host_type: 'stdio',
      allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
      sha256: 'new',
    };
    const action = normaliseEvent(raw, {
      sha256: 'old',
      allowed_origins: [],
    });
    expect(action?.sha256_previous).toBe('old');
    expect(action?.allowed_origins_diff?.added).toEqual([
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',
    ]);
    expect(action?.allowed_origins_diff?.removed).toEqual([]);
  });
});

describe('evaluateNativeMessagingHost — default policy', () => {
  const policy = defaultNmhPolicy();

  it('Anthropic baseline manifest -> warn (AI vendor, always surface)', () => {
    const v = evaluateNativeMessagingHost(anthropicAction(), policy);
    expect(v.decision).toBe('warn');
    expect(v.rule).toBe('vendor-manifest-clean');
    expect(v.notify).toBe(true);
  });

  it('Dropbox baseline manifest -> allow silently', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        vendor: 'com.dropbox.nmh',
        binary_path: '/Applications/Dropbox.app/Contents/MacOS/dropbox_nmh',
        allowed_origins: [],
      }),
      policy,
    );
    expect(v.decision).toBe('allow');
    expect(v.notify).toBe(false);
  });

  it('unknown vendor -> warn (fail-open default) with notify', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        vendor: 'com.openai.chatgpt-desktop',
        binary_path: '/Applications/ChatGPT.app/Contents/MacOS/nmh',
        allowed_origins: ['chrome-extension://pppppppppppppppppppppppppppppppp/'],
      }),
      policy,
    );
    expect(v.decision).toBe('warn');
    expect(v.rule).toBe('unknown-vendor');
    expect(v.notify).toBe(true);
  });

  it('unknown vendor under fail-closed policy -> deny', () => {
    const strict: NativeMessagingHostPolicy = {
      ...policy,
      failClosed: true,
    };
    const v = evaluateNativeMessagingHost(
      anthropicAction({ vendor: 'com.mystery.bridge' }),
      strict,
    );
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('unknown-vendor-fail-closed');
  });

  it('binary outside /Applications/** -> deny', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        binary_path: '/tmp/sketchy-bridge',
      }),
      policy,
    );
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('binary-outside-global-roots');
  });

  it('binary in /Applications/Spoof.app (not vendor prefix) -> deny', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        binary_path: '/Applications/Spoof.app/Contents/MacOS/fake',
      }),
      policy,
    );
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('binary-outside-vendor-prefix');
  });

  it('Anthropic modify adding a new extension ID -> deny (silent change)', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        event: 'modified',
        allowed_origins: [
          ...ANTHROPIC_ORIGINS,
          'chrome-extension://oooooooooooooooooooooooooooooooo/',
        ],
        allowed_origins_diff: {
          added: ['chrome-extension://oooooooooooooooooooooooooooooooo/'],
          removed: [],
        },
      }),
      policy,
    );
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('ai-vendor-silent-extension-id-added');
  });

  it('Anthropic manifest with extension ID outside allowlist on baseline -> deny', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        allowed_origins: [
          'chrome-extension://mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm/',
        ],
      }),
      policy,
    );
    expect(v.decision).toBe('deny');
    expect(v.rule).toBe('unknown-extension-id-for-vendor');
  });

  it('Google Drive with its known extension ID -> allow', () => {
    const v = evaluateNativeMessagingHost(
      anthropicAction({
        vendor: 'com.google.drive.nativeproxy',
        binary_path: '/Applications/Google Drive.app/Contents/MacOS/proxy',
        allowed_origins: [
          'chrome-extension://lmjegmlicamnimmfhcmpkclmigmmcbeh/',
        ],
      }),
      policy,
    );
    expect(v.decision).toBe('allow');
    expect(v.rule).toBe('vendor-manifest-clean');
  });
});

describe('actionSummary + syntheticScanId', () => {
  it('produces a compact human-readable summary', () => {
    const s = actionSummary(anthropicAction());
    expect(s).toContain('baseline');
    expect(s).toContain('chromium:com.anthropic.claude_browser_extension');
    expect(s).toContain('origins=3');
    expect(s).toContain('sha=e47dd53d0af4');
  });

  it('synthetic scan_id starts with vcce- and includes short sha', () => {
    const id = syntheticScanId(anthropicAction(), '2026-04-22T20:00:00Z');
    expect(id).toMatch(/^vcce-e47dd53d0af4-[0-9a-f]{6}$/);
  });

  it('synthetic scan_id is stable for the same path+ts+sha', () => {
    const a = anthropicAction();
    const id1 = syntheticScanId(a, '2026-04-22T20:00:00Z');
    const id2 = syntheticScanId(a, '2026-04-22T20:00:00Z');
    expect(id1).toBe(id2);
  });
});
