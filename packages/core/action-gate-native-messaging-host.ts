/**
 * action-gate-native-messaging-host.ts — RAI ActionGate NMH adapter (L4)
 *
 * Deterministic policy engine for Vendor Covert Capability Expansion (VCCE):
 * a trusted vendor writes a Native Messaging Host manifest into a browser's
 * well-known directory, establishing a stdio IPC bridge between a local
 * binary and one or more pre-authorised browser extensions.
 *
 * Anchor case: Anthropic Claude Desktop drops com.anthropic.claude_browser_extension.json
 * into 7 Chromium-family browsers at install time, with 3 pre-authorised
 * extension IDs — only 1 of which is publicly auditable on the CWS.
 *
 * Spec: 28-rai-actiongate-spec.md § Surface Adapter: native-messaging-host
 * Upstream event source: ~/.rai/vcce-watch.jsonl (produced by rai-vcce-watch.sh).
 *
 * Same principles as fs-git + shell: pure function, first-rule-wins, fail-closed
 * on unknown vendors by default.
 */

// ---------------------------------------------------------------------------
// Input: raw events from vcce-watch.jsonl
// ---------------------------------------------------------------------------

/**
 * Raw event shape as emitted by rai-vcce-watch.sh. Heartbeat and parse_error
 * events are surfaced so the runner can handle them separately from actions.
 */
export interface VcceWatchEvent {
  ts: string;
  event: 'baseline' | 'created' | 'modified' | 'removed' | 'heartbeat' | string;
  browser?: string;
  path?: string;
  vendor?: string;
  binary?: string;
  host_type?: string;
  allowed_origins?: string[];
  sha256?: string;
  parse_error?: boolean;
}

// ---------------------------------------------------------------------------
// Normalised action shape
// ---------------------------------------------------------------------------

export type NmhEventType = 'baseline' | 'created' | 'modified' | 'removed';
export type NmhOs = 'macos' | 'linux' | 'windows';

export interface NativeMessagingHostAction {
  kind: 'native-messaging-host-manifest';
  event: NmhEventType;
  os: NmhOs;
  browser: string;
  path: string;
  vendor: string;
  binary_path: string;
  host_type: string;
  allowed_origins: string[];
  sha256: string;
  /** Populated when event !== 'baseline' and a previous sha256 is known. */
  sha256_previous?: string;
  /** Populated on modified events when diff against baseline is available. */
  allowed_origins_diff?: {
    added: string[];
    removed: string[];
  };
}

/**
 * Translate a raw watcher event into an NMH action. Returns null for
 * non-action events (heartbeat, parse_error, removed, unrecognised shape).
 *
 * `os` is inferred from the path layout. Only macOS is implemented today
 * (Option 1); Linux/Windows inference lives here so the adapter API stays
 * stable when those surfaces land.
 */
export function normaliseEvent(
  raw: VcceWatchEvent,
  previous?: { sha256?: string; allowed_origins?: string[] },
): NativeMessagingHostAction | null {
  const ev = raw.event;
  if (
    ev !== 'baseline' &&
    ev !== 'created' &&
    ev !== 'modified' &&
    ev !== 'removed'
  ) {
    return null;
  }
  if (ev === 'removed') {
    // Removal events are interesting but not policy-evaluable here.
    // The runner logs them with a dedicated 'manifest-removed' rule.
    return null;
  }
  if (raw.parse_error) return null;
  if (!raw.path || !raw.vendor || !raw.sha256) return null;

  const os = inferOs(raw.path);
  const action: NativeMessagingHostAction = {
    kind: 'native-messaging-host-manifest',
    event: ev,
    os,
    browser: raw.browser ?? 'unknown',
    path: raw.path,
    vendor: raw.vendor,
    binary_path: raw.binary ?? '',
    host_type: raw.host_type ?? '',
    allowed_origins: raw.allowed_origins ?? [],
    sha256: raw.sha256,
  };

  if (previous?.sha256 && previous.sha256 !== raw.sha256) {
    action.sha256_previous = previous.sha256;
  }
  if (previous?.allowed_origins) {
    const diff = diffOrigins(previous.allowed_origins, action.allowed_origins);
    if (diff.added.length || diff.removed.length) {
      action.allowed_origins_diff = diff;
    }
  }
  return action;
}

function inferOs(p: string): NmhOs {
  if (p.startsWith('/Users/') || p.includes('/Library/Application Support/'))
    return 'macos';
  if (p.startsWith('/home/') || p.includes('/.config/')) return 'linux';
  if (p.startsWith('HKEY_') || /[A-Z]:\\/.test(p)) return 'windows';
  return 'macos';
}

function diffOrigins(
  prev: string[],
  curr: string[],
): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  return {
    added: curr.filter((x) => !prevSet.has(x)),
    removed: prev.filter((x) => !currSet.has(x)),
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type NmhDecision = 'allow' | 'warn' | 'deny';

export interface NmhVerdict {
  decision: NmhDecision;
  rule: string;
  reason: string;
  /** True when the runner should surface this to the user (notify channel). */
  notify: boolean;
}

export interface VendorConfig {
  /** Glob-like prefixes the binary path must match (e.g. '/Applications/Claude.app/'). */
  allowedBinaryPathPrefixes: string[];
  /** Extension IDs that MAY appear in allowed_origins. */
  allowedExtensionIds: string[];
  /** Verdict when the manifest matches the known-good configuration. */
  verdictOnClean: NmhDecision;
  /** Verdict when allowed_origins contains an ID outside allowedExtensionIds. */
  verdictOnUnknownExtensionId: NmhDecision;
  /** True = vendor classified as an AI vendor (triggers stricter rules). */
  aiVendor: boolean;
  /** Human-friendly label for UI and audit entries. */
  label?: string;
}

export interface NativeMessagingHostPolicy {
  /** If true, unknown vendors produce 'deny'; if false, fall through to unknownVendorVerdict. */
  failClosed: boolean;
  vendors: Map<string, VendorConfig>;
  unknownVendorVerdict: NmhDecision;
  unknownVendorReason: string;
  /** Global allowed roots for any binary_path. Empty = no global check. */
  globalBinaryAllowedRoots: string[];
}

/**
 * Policy as captured in 28-rai-actiongate-spec.md on the session that shipped
 * the v0 watcher. Safe in-code default so the adapter is useful without a
 * YAML file on disk.
 */
export function defaultNmhPolicy(): NativeMessagingHostPolicy {
  const vendors = new Map<string, VendorConfig>();

  vendors.set('com.dropbox.nmh', {
    allowedBinaryPathPrefixes: ['/Applications/Dropbox.app/'],
    // Dropbox Passwords browser extensions (Chrome/Firefox/Edge variants).
    allowedExtensionIds: [
      'ekldlkjidcgmplkohfmhlijlplhibknj',
      'dfcjmolhhmklkbpghfeafoipgdekjien',
      'bmhejbnmpamgfnomlahkonpanlkcfabg',
    ],
    verdictOnClean: 'allow',
    verdictOnUnknownExtensionId: 'warn',
    aiVendor: false,
    label: 'Dropbox',
  });

  vendors.set('com.google.drive.nativeproxy', {
    allowedBinaryPathPrefixes: ['/Applications/Google Drive.app/'],
    // Google Drive for desktop (switchblade_host) companion extension.
    allowedExtensionIds: ['lmjegmlicamnimmfhcmpkclmigmmcbeh'],
    verdictOnClean: 'allow',
    verdictOnUnknownExtensionId: 'warn',
    aiVendor: false,
    label: 'Google Drive',
  });

  vendors.set('com.anthropic.claude_browser_extension', {
    allowedBinaryPathPrefixes: ['/Applications/Claude.app/'],
    allowedExtensionIds: [
      'dihbgbndebgnbjfmelmegjepbnkhlgni', // reserved (404 on CWS 2026-04-22)
      'fcoeoabgfenejglbffodgkkbkcdhcgfn', // public Beta, 6M users
      'dngcpimnedloihjnnfngkgjoidhnaolf', // unlisted / 401-gated private
    ],
    verdictOnClean: 'warn',
    verdictOnUnknownExtensionId: 'deny',
    aiVendor: true,
    label: 'Anthropic Claude Desktop',
  });

  return {
    failClosed: false,
    vendors,
    unknownVendorVerdict: 'warn',
    unknownVendorReason:
      'Unknown vendor installed a Native Messaging bridge. Review before use.',
    globalBinaryAllowedRoots: ['/Applications/', '/usr/local/bin/', '/opt/'],
  };
}

// ---------------------------------------------------------------------------
// Evaluation — first rule wins
// ---------------------------------------------------------------------------

export function evaluateNativeMessagingHost(
  action: NativeMessagingHostAction,
  policy: NativeMessagingHostPolicy,
): NmhVerdict {
  const vendor = policy.vendors.get(action.vendor);

  // Rule 1: unknown vendor.
  if (!vendor) {
    if (policy.failClosed) {
      return {
        decision: 'deny',
        rule: 'unknown-vendor-fail-closed',
        reason: `vendor "${action.vendor}" not in policy (fail-closed mode)`,
        notify: true,
      };
    }
    return {
      decision: policy.unknownVendorVerdict,
      rule: 'unknown-vendor',
      reason: policy.unknownVendorReason,
      notify: policy.unknownVendorVerdict !== 'allow',
    };
  }

  // Rule 2: binary path outside global allowed roots.
  if (
    policy.globalBinaryAllowedRoots.length > 0 &&
    action.binary_path &&
    !policy.globalBinaryAllowedRoots.some((root) =>
      action.binary_path.startsWith(root),
    )
  ) {
    return {
      decision: 'deny',
      rule: 'binary-outside-global-roots',
      reason: `binary path "${action.binary_path}" is outside allowed global roots`,
      notify: true,
    };
  }

  // Rule 3: binary path outside vendor-specific allowed prefixes.
  if (
    vendor.allowedBinaryPathPrefixes.length > 0 &&
    action.binary_path &&
    !vendor.allowedBinaryPathPrefixes.some((p) =>
      action.binary_path.startsWith(p),
    )
  ) {
    return {
      decision: 'deny',
      rule: 'binary-outside-vendor-prefix',
      reason: `binary path "${action.binary_path}" not in vendor allowlist for "${action.vendor}"`,
      notify: true,
    };
  }

  // Rule 4: AI vendor silently added an extension ID on modify = hard deny.
  if (
    vendor.aiVendor &&
    action.event === 'modified' &&
    action.allowed_origins_diff &&
    action.allowed_origins_diff.added.length > 0
  ) {
    return {
      decision: 'deny',
      rule: 'ai-vendor-silent-extension-id-added',
      reason: `AI vendor "${action.vendor}" added extension ID(s) without user action: ${action.allowed_origins_diff.added.join(', ')}`,
      notify: true,
    };
  }

  // Rule 5: allowed_origins contains an extension ID outside the vendor list.
  const allowedIds = new Set(vendor.allowedExtensionIds);
  const foundUnknown: string[] = [];
  for (const origin of action.allowed_origins) {
    const id = extractExtensionId(origin);
    if (id && !allowedIds.has(id)) foundUnknown.push(id);
  }
  if (foundUnknown.length > 0) {
    return {
      decision: vendor.verdictOnUnknownExtensionId,
      rule: 'unknown-extension-id-for-vendor',
      reason: `extension ID(s) not in vendor allowlist: ${foundUnknown.join(', ')}`,
      notify: vendor.verdictOnUnknownExtensionId !== 'allow',
    };
  }

  // Rule 6: clean match against vendor config.
  return {
    decision: vendor.verdictOnClean,
    rule: 'vendor-manifest-clean',
    reason: vendor.aiVendor
      ? `AI vendor "${vendor.label ?? action.vendor}" manifest matches known configuration — surfaced for review`
      : `vendor "${vendor.label ?? action.vendor}" manifest matches known-good configuration`,
    notify: vendor.verdictOnClean !== 'allow',
  };
}

/**
 * Parse "chrome-extension://<id>/" -> "<id>". Returns null on malformed input.
 */
export function extractExtensionId(origin: string): string | null {
  const m = origin.match(/^chrome-extension:\/\/([a-p]{32})\/?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Audit summary builder
// ---------------------------------------------------------------------------

/**
 * One-line human-readable summary of the action for the audit log.
 * Kept short so it fits in grep/jq/dashboard tables.
 */
export function actionSummary(action: NativeMessagingHostAction): string {
  const n = action.allowed_origins.length;
  const diffPart = action.allowed_origins_diff
    ? ` diff=+${action.allowed_origins_diff.added.length}/-${action.allowed_origins_diff.removed.length}`
    : '';
  return `${action.event} ${action.browser}:${action.vendor} origins=${n}${diffPart} sha=${action.sha256.slice(0, 12)}`;
}

/**
 * Synthetic scan_id for VCCE events. The upstream file-system event has no
 * LLM conversation attached, so we produce a stable identifier derived from
 * the event's content so repeated observations of the same write produce
 * the same id (dedupe-friendly).
 */
export function syntheticScanId(
  action: NativeMessagingHostAction,
  ts: string,
): string {
  const shortSha = action.sha256.slice(0, 12);
  const pathHash = hashShortString(`${action.path}:${ts}`);
  return `vcce-${shortSha}-${pathHash}`;
}

function hashShortString(s: string): string {
  // djb2, 6 hex chars — good enough for an audit correlation key, not crypto.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return ((h >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}
