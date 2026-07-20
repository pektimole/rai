/**
 * block-reason.ts — RAI-Block-Reason header set, v1 (OL-300, 33- Part B)
 *
 * When a scanner or gateway blocks a request, it must say *why* in a
 * machine-readable form an agent can act on (back off, switch tools, surface
 * the right error) rather than an opaque 403.
 *
 * LOCK THE VOCABULARY before any production consumer reads it.
 * Renaming a reason code is a breaking change — bump schema_version and add a
 * compat shim. This file is the single source of truth for the v1 vocabulary.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part B).
 *
 * Privacy rules (hard — see spec § Privacy):
 *   - Never expose matched secret content, pattern names, session IDs, agent
 *     IDs, user-attributable data, internal IPs, or private hostnames.
 *   - Required values (Reason, Severity, Retry) are validated against fixed
 *     allowlists at construction; any unknown value causes the emit to fall
 *     back to `bad_request`.
 *   - The Receipt slot accepts only a fixed-length ULID / UUIDv7 pattern; no
 *     attacker-controlled string reaches an agent-visible header.
 */

// ---------------------------------------------------------------------------
// Vocabulary (v1) — locked; changes require schema_version bump
// ---------------------------------------------------------------------------

const REASON_CODES = [
  // Egress
  'scheme_blocked',
  'domain_blocklist',
  'ssrf_private_ip',
  'ssrf_metadata',
  'ssrf_dns_rebind',
  'path_entropy',
  'subdomain_entropy',
  'url_length',
  'rate_limit',
  'data_budget',
  // Content
  'dlp_match',
  'prompt_injection',
  'redaction_failure',
  'media_policy',
  // MCP / tool
  'tool_policy_deny',
  'tool_chain_blocked',
  'tool_poisoning',
  'session_binding',
  // Posture
  'kill_switch_active',
  'authority_mismatch',
  'escalation_level',
  'session_anomaly',
  'cross_request_deny',
  'redirect_scan_denied',
  // Contract / learn-and-lock
  'contract_default_deny',
  'contract_enforce_default',
  'contract_non_default_port',
  'contract_invalid_path',
  // Generic
  'parse_error',
  'timeout',
  'pattern_unavailable',
  'not_enabled',
  'bad_request',
  'block_reason_overflow',
] as const;

export type BlockReasonCode = (typeof REASON_CODES)[number];

const SEVERITIES = ['info', 'warn', 'critical'] as const;
export type BlockReasonSeverity = (typeof SEVERITIES)[number];

const RETRIES = ['none', 'transient', 'policy', 'retry-with-canonical-path'] as const;
export type BlockReasonRetry = (typeof RETRIES)[number];

// ---------------------------------------------------------------------------
// Header set types
// ---------------------------------------------------------------------------

export const BLOCK_REASON_VERSION = 1;

/** Fully-structured block reason, validated. Omit optional fields when absent. */
export interface BlockReasonHeaders {
  'RAI-Block-Reason': BlockReasonCode;
  'RAI-Block-Reason-Version': typeof BLOCK_REASON_VERSION;
  'RAI-Block-Reason-Severity': BlockReasonSeverity;
  'RAI-Block-Reason-Retry': BlockReasonRetry;
  'RAI-Block-Reason-Layer'?: string;
  'RAI-Block-Reason-Receipt'?: string; // ULID or UUIDv7
}

/** Shape for builder callers before validation; `reason` may be a free string
 *  that gets sanitized to a valid code or falls back to `bad_request`. */
export interface BlockReasonInput {
  reason: string;
  severity: string;
  retry: string;
  layer?: string;
  receipt?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const REASON_SET = new Set<string>(REASON_CODES);
const SEVERITY_SET = new Set<string>(SEVERITIES);
const RETRY_SET = new Set<string>(RETRIES);

/** Max header-value length enforced across all fields. */
const MAX_HEADER_VALUE = 200;

/** ULID (26 Crockford base-32 chars) or UUIDv7 (RFC 9562). */
const RECEIPT_RE = /^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Layer label: alphanumeric + hyphens/underscores, ≤40 chars. */
const LAYER_RE = /^[a-zA-Z0-9_-]{1,40}$/;

function sanitizeReason(v: string): BlockReasonCode {
  if (v.length <= MAX_HEADER_VALUE && REASON_SET.has(v)) return v as BlockReasonCode;
  return 'bad_request';
}

function sanitizeSeverity(v: string): BlockReasonSeverity {
  if (SEVERITY_SET.has(v)) return v as BlockReasonSeverity;
  return 'warn';
}

function sanitizeRetry(v: string): BlockReasonRetry {
  if (RETRY_SET.has(v)) return v as BlockReasonRetry;
  return 'none';
}

function sanitizeLayer(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (LAYER_RE.test(v)) return v;
  return undefined; // drop non-conforming; never forward attacker-controlled strings
}

function sanitizeReceipt(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (RECEIPT_RE.test(v)) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a validated `RAI-Block-Reason` header set. All string fields are
 * checked against their allowlists before reaching the wire. Unknown or
 * malformed values are silently clamped to safe defaults (never forwarded).
 */
export function buildBlockReasonHeaders(input: BlockReasonInput): BlockReasonHeaders {
  const headers: BlockReasonHeaders = {
    'RAI-Block-Reason': sanitizeReason(input.reason),
    'RAI-Block-Reason-Version': BLOCK_REASON_VERSION,
    'RAI-Block-Reason-Severity': sanitizeSeverity(input.severity),
    'RAI-Block-Reason-Retry': sanitizeRetry(input.retry),
  };
  const layer = sanitizeLayer(input.layer);
  if (layer) headers['RAI-Block-Reason-Layer'] = layer;
  const receipt = sanitizeReceipt(input.receipt);
  if (receipt) headers['RAI-Block-Reason-Receipt'] = receipt;
  return headers;
}

/**
 * Serialize a validated header set to a flat `Record<string, string>` for
 * direct use with `res.setHeader()` or similar.
 */
export function headersToRecord(h: BlockReasonHeaders): Record<string, string> {
  const out: Record<string, string> = {
    'RAI-Block-Reason': h['RAI-Block-Reason'],
    'RAI-Block-Reason-Version': String(h['RAI-Block-Reason-Version']),
    'RAI-Block-Reason-Severity': h['RAI-Block-Reason-Severity'],
    'RAI-Block-Reason-Retry': h['RAI-Block-Reason-Retry'],
  };
  if (h['RAI-Block-Reason-Layer']) out['RAI-Block-Reason-Layer'] = h['RAI-Block-Reason-Layer'];
  if (h['RAI-Block-Reason-Receipt']) out['RAI-Block-Reason-Receipt'] = h['RAI-Block-Reason-Receipt'];
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket close-frame framing (RFC 6455 — 123-byte payload cap)
// ---------------------------------------------------------------------------

/** Fields in drop order when the 123-byte cap is tight (spec order). */
const WS_FIELD_DROP_ORDER: (keyof BlockReasonHeaders)[] = [
  'RAI-Block-Reason-Receipt',
  'RAI-Block-Reason-Layer',
  'RAI-Block-Reason-Retry',
  'RAI-Block-Reason-Severity',
  'RAI-Block-Reason-Version',
];

const WS_PAYLOAD_CAP = 123;

/**
 * Encode block reason for a WebSocket close-frame payload (≤123 bytes).
 * Fields are dropped in the spec order until it fits; `block_reason` is
 * always present as the floor.
 *
 * Returns a Buffer ready for the close-frame data field.
 */
export function encodeWsClosePayload(h: BlockReasonHeaders): Buffer {
  const obj: Record<string, unknown> = {
    block_reason: h['RAI-Block-Reason'],
    version: h['RAI-Block-Reason-Version'],
    severity: h['RAI-Block-Reason-Severity'],
    retry: h['RAI-Block-Reason-Retry'],
  };
  if (h['RAI-Block-Reason-Layer']) obj['layer'] = h['RAI-Block-Reason-Layer'];
  if (h['RAI-Block-Reason-Receipt']) obj['receipt'] = h['RAI-Block-Reason-Receipt'];

  // Map header names to the compact WS keys (used in drop loop below).
  const headerToKey: Partial<Record<keyof BlockReasonHeaders, string>> = {
    'RAI-Block-Reason-Receipt': 'receipt',
    'RAI-Block-Reason-Layer': 'layer',
    'RAI-Block-Reason-Retry': 'retry',
    'RAI-Block-Reason-Severity': 'severity',
    'RAI-Block-Reason-Version': 'version',
  };

  let payload = Buffer.from(JSON.stringify(obj), 'utf-8');
  for (const field of WS_FIELD_DROP_ORDER) {
    if (payload.length <= WS_PAYLOAD_CAP) break;
    const key = headerToKey[field];
    if (key && key in obj) {
      delete obj[key];
      payload = Buffer.from(JSON.stringify(obj), 'utf-8');
    }
  }
  if (payload.length > WS_PAYLOAD_CAP) {
    // Last resort: emit the floor only.
    payload = Buffer.from(JSON.stringify({ block_reason: h['RAI-Block-Reason'] }), 'utf-8');
  }
  return payload;
}

// ---------------------------------------------------------------------------
// MCP-stdio framing (JSON-RPC error envelope)
// ---------------------------------------------------------------------------

/** MCP-stdio has no HTTP layer; reasons flow through the JSON-RPC error
 *  envelope as `data.block_reason.*`. Returns the `data` object to embed. */
export function encodeMcpErrorData(h: BlockReasonHeaders): Record<string, unknown> {
  const data: Record<string, unknown> = {
    block_reason: {
      reason: h['RAI-Block-Reason'],
      version: h['RAI-Block-Reason-Version'],
      severity: h['RAI-Block-Reason-Severity'],
      retry: h['RAI-Block-Reason-Retry'],
    },
  };
  const br = data['block_reason'] as Record<string, unknown>;
  if (h['RAI-Block-Reason-Layer']) br['layer'] = h['RAI-Block-Reason-Layer'];
  if (h['RAI-Block-Reason-Receipt']) br['receipt'] = h['RAI-Block-Reason-Receipt'];
  return data;
}

// ---------------------------------------------------------------------------
// Scanner-output adapter
// ---------------------------------------------------------------------------

/**
 * Derive block-reason inputs from a P0 scanner output. Maps the scanner's
 * ThreatLayer + severity vocabulary onto the header vocabulary.
 *
 * Privacy: the scanner's `explanation` string is NOT forwarded (it may
 * contain matched-pattern labels). Only structural metadata crosses the wire.
 */
export function blockReasonFromScanSignals(signals: {
  layer: string;
  severity: string;
  label: string;
}[]): BlockReasonInput {
  if (!signals.length) {
    return { reason: 'bad_request', severity: 'warn', retry: 'none' };
  }

  // Pick the highest-severity signal as the primary reason.
  const severityRank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const top = signals.reduce((a, b) =>
    (severityRank[b.severity] ?? 0) > (severityRank[a.severity] ?? 0) ? b : a,
  );

  // Map layer to reason code — best-effort structural mapping.
  const layerToReason: Record<string, BlockReasonCode> = {
    'L-2': 'prompt_injection',
    'L-1': 'prompt_injection',
    L0: 'prompt_injection',
    L1: 'prompt_injection',
    L2: 'session_anomaly',
    L3: 'cross_request_deny',
  };

  // Narrow by label substring for DLP hits.
  const labelLower = top.label.toLowerCase();
  let reason: BlockReasonCode = layerToReason[top.layer] ?? 'bad_request';
  if (labelLower.includes('credential') || labelLower.includes('secret') || labelLower.includes('dlp')) {
    reason = 'dlp_match';
  } else if (labelLower.includes('exfil') || labelLower.includes('domain')) {
    reason = 'domain_blocklist';
  }

  const severity: BlockReasonSeverity =
    top.severity === 'critical' || top.severity === 'high'
      ? 'critical'
      : top.severity === 'medium'
        ? 'warn'
        : 'info';

  // Prompt injection and DLP: permanent block (none). Session anomaly: transient.
  const retry: BlockReasonRetry =
    top.layer === 'L2' || top.layer === 'L3' ? 'transient' : 'none';

  const layer = top.layer.replace('-', 'minus-').replace(/[^a-zA-Z0-9_-]/g, '');

  return { reason, severity, retry, layer };
}

// ---------------------------------------------------------------------------
// Re-export the reason codes array for tests and tooling
// ---------------------------------------------------------------------------
export { REASON_CODES, SEVERITIES, RETRIES };
