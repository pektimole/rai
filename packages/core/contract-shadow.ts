/**
 * contract-shadow.ts — Learn-and-lock phase 3: shadow (OL-461)
 *
 * Replays captured traffic through a candidate behavioral contract WITHOUT
 * enforcing, and emits the "would-have-blocked" deltas so an operator sees the
 * contract's exact effect before ratifying it to enforce (docs/33-rai-l1-
 * hotreload-spec.md Part A, phase 3). Nothing here blocks: every verdict is
 * annotated observed_only, the shadow/telemetry surface the spec reserves for
 * `contract_observed_only` — it must never reach a real block path.
 *
 * The replay is the dry-run of the SAME allowlist semantics ratify will make
 * live, so the deltas are trustworthy. Three properties matter:
 *
 *  1. Two-level jurisdiction, matching the block-reason vocabulary. A contracted
 *     agent is locked to observed behavior, so anything outside the allowlist is
 *     denied — but the reason distinguishes degree:
 *       - host/server the contract never saw       → contract_default_deny
 *       - host/server known, this shape disallowed  → contract_enforce_default
 *       - path matched a rule, port was not observed → contract_non_default_port
 *       - path is not canonical (has ./.. or //)     → contract_invalid_path
 *     default_deny means "brand-new destination"; enforce_default means "known
 *     host, new shape" (often a normalization gap the operator should split/pin).
 *
 *  2. Typed placeholder matching — STRICTER than compile's attribution matcher.
 *     Compile's bestTemplate matches paths it derived the templates from, so it
 *     only checks placeholder-ness. Shadow replays fresh traffic, so a
 *     placeholder matches by SHAPE: `<id>` only numeric, `<uuid>`/`<hex>` by
 *     shape, `<var>` any single segment. A `/users/<id>` rule therefore does NOT
 *     allow `/users/admin` — enforce is exactly what should catch a new shape the
 *     recorder never observed. (Compile's reserved-segment blocklist keeps
 *     `admin` from ever collapsing into `<id>` in the first place; this is the
 *     enforcement-time counterpart.)
 *
 *  3. Only the enforce-set participates. By default that is the ratify-eligible
 *     rules (lifecycle `enforce`, or `proposed` rules that are `stable`), so a
 *     shadow run answers "what happens if I ratify the eligible rules?". An
 *     explicit id set lets an operator shadow a subset (the per-rule ratify /
 *     forget / diff verbs).
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, phase 3: shadow).
 */

import {
  contractId,
  splitPath,
  type BehavioralContract,
  type ContractRule,
  type HttpDestinationRule,
  type McpToolCallRule,
} from './contract-compile.js';
import type { FlightEvent, FlightSession } from './contract-recorder.js';

// ---------------------------------------------------------------------------
// Verdict + report shapes
// ---------------------------------------------------------------------------

export type ShadowDecision = 'allow' | 'deny';

/**
 * Contract-layer reason codes (docs/33 Part B). `contract_allow` is the
 * allow-side annotation only; every other value is a block reason. All of them
 * are dry-run here — the verdict's observed_only flag marks the whole run as the
 * telemetry surface, never a live block.
 */
export type ContractReason =
  | 'contract_allow'
  | 'contract_default_deny'
  | 'contract_enforce_default'
  | 'contract_non_default_port'
  | 'contract_invalid_path';

/** The block reasons, for tallying (excludes the allow annotation). */
export const CONTRACT_BLOCK_REASONS: ContractReason[] = [
  'contract_default_deny',
  'contract_enforce_default',
  'contract_non_default_port',
  'contract_invalid_path',
];

export interface ShadowVerdict {
  decision: ShadowDecision;
  reason: ContractReason;
  /** Matched rule (allow) or nearest rule (deny); absent for default_deny. */
  rule_id?: string;
  session_id: string;
  ts: string;
  event: FlightEvent;
  /** Shadow never enforces — receipts/telemetry only. Always true. */
  observed_only: true;
}

export interface ShadowScopeStat {
  scope_kind: 'http_host' | 'mcp_server';
  scope: string;
  total: number;
  allowed: number;
  denied: number;
}

export interface ShadowReport {
  agent: string;
  /** Binds the report to the exact contract body it was run against. */
  contract_id: string;
  /** The rule ids treated as enforcing during this replay. */
  enforce_rule_ids: string[];
  total_events: number;
  allowed: number;
  denied: number;
  /** The deltas: every event this contract would have blocked, in order. */
  would_block: ShadowVerdict[];
  /** Deny count per block reason. */
  by_reason: Record<ContractReason, number>;
  /** Per host/server allow-vs-deny breakdown. */
  by_scope: ShadowScopeStat[];
}

export interface ShadowOptions {
  /**
   * Rule ids to treat as enforcing. Omit for the default: the ratify-eligible
   * set (lifecycle `enforce`, or `proposed` rules that cleared every floor and
   * are `stable`). Pass an explicit set to shadow a subset before ratifying it.
   */
  enforceRuleIds?: string[];
}

// ---------------------------------------------------------------------------
// Typed placeholder matching (replay-strict)
// ---------------------------------------------------------------------------

const RE_NUMERIC = /^\d+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_LONGHEX = /^[0-9a-f]{16,}$/i;

/** Does one template segment accept one concrete segment? Placeholders match by
 *  shape; anything else is a literal equality. Mirrors compile's placeholderFor
 *  typing so the two phases agree on what a `<id>` means. */
function segMatches(tmpl: string, seg: string): boolean {
  switch (tmpl) {
    case '<id>':
      return RE_NUMERIC.test(seg);
    case '<uuid>':
      return RE_UUID.test(seg);
    case '<hex>':
      return RE_LONGHEX.test(seg);
    case '<var>':
      return seg.length > 0;
    default:
      // An unrecognized <...> placeholder is treated as match-any (defensive;
      // compile only ever emits the four above). Literals must match exactly.
      if (tmpl.startsWith('<') && tmpl.endsWith('>')) return seg.length > 0;
      return tmpl === seg;
  }
}

/** Typed match of a concrete path against a normalized template. */
function pathMatchesTemplate(pathSegs: string[], template: string): boolean {
  const tSegs = splitPath(template);
  if (tSegs.length !== pathSegs.length) return false;
  for (let i = 0; i < tSegs.length; i++) {
    if (!segMatches(tSegs[i], pathSegs[i])) return false;
  }
  return true;
}

/** A path is canonical when every segment is a real name: no empty (`//`),
 *  no `.`/`..` traversal. Non-canonical paths get contract_invalid_path
 *  (retry-with-canonical-path) rather than being silently normalized. */
function isCanonicalPath(p: string): boolean {
  if (!p.startsWith('/')) return false;
  if (p.includes('//')) return false;
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Enforce-set selection
// ---------------------------------------------------------------------------

/** A rule is enforced-by-default in shadow if it is already `enforce` or is a
 *  `proposed` rule that cleared every floor (stable → ratify-eligible). */
function defaultEnforced(r: ContractRule): boolean {
  return r.lifecycle === 'enforce' || r.confidence.stable;
}

function selectEnforceSet(contract: BehavioralContract, opts: ShadowOptions): ContractRule[] {
  if (opts.enforceRuleIds) {
    const wanted = new Set(opts.enforceRuleIds);
    return contract.rules.filter((r) => wanted.has(r.id));
  }
  return contract.rules.filter(defaultEnforced);
}

// ---------------------------------------------------------------------------
// Per-event evaluation
// ---------------------------------------------------------------------------

function isHttp(r: ContractRule): r is HttpDestinationRule {
  return r.kind === 'http_destination';
}
function isMcp(r: ContractRule): r is McpToolCallRule {
  return r.kind === 'mcp_tool_call';
}

type Narrowed<K extends FlightEvent['kind']> = Extract<FlightEvent, { kind: K }>;

/** Evaluate one HTTP event against the enforce-set. Returns {decision, reason,
 *  rule_id}. Pure — no side effects, no enforcement. */
function evalHttp(
  ev: Narrowed<'http_destination'>,
  httpRules: HttpDestinationRule[],
): { decision: ShadowDecision; reason: ContractReason; rule_id?: string } {
  // Malformed path never reaches rule matching — retry-with-canonical-path.
  if (!isCanonicalPath(ev.path)) {
    return { decision: 'deny', reason: 'contract_invalid_path' };
  }

  const hostRules = httpRules.filter((r) => r.host === ev.host);
  if (hostRules.length === 0) {
    // Jurisdiction claimed (agent is locked), host never observed.
    return { decision: 'deny', reason: 'contract_default_deny' };
  }

  const pathSegs = splitPath(ev.path);
  let portMiss: HttpDestinationRule | undefined; // path matched, port not observed

  for (const r of hostRules) {
    if (r.method !== ev.method) continue;
    if (!pathMatchesTemplate(pathSegs, r.path_template)) continue;
    // Path (and method) fit this rule. Now the rest of the shape.
    const portOk = r.ports.includes(ev.port);
    const schemeOk = r.schemes.includes(ev.scheme);
    if (portOk && schemeOk) {
      return { decision: 'allow', reason: 'contract_allow', rule_id: r.id };
    }
    if (!portOk) {
      portMiss = portMiss ?? r; // remember the strongest near-miss
    }
    // scheme-only miss falls through to enforce_default below.
  }

  if (portMiss) {
    // Same path shape, a port the recorder never saw → its own named reason.
    return { decision: 'deny', reason: 'contract_non_default_port', rule_id: portMiss.id };
  }
  // Host known, but method/path/scheme shape is outside the allowlist.
  return { decision: 'deny', reason: 'contract_enforce_default', rule_id: hostRules[0].id };
}

/** Evaluate one MCP tool call against the enforce-set. server = host-analog,
 *  tool = shape-analog. */
function evalMcp(
  ev: Narrowed<'mcp_tool_call'>,
  mcpRules: McpToolCallRule[],
): { decision: ShadowDecision; reason: ContractReason; rule_id?: string } {
  const serverRules = mcpRules.filter((r) => r.server === ev.server);
  if (serverRules.length === 0) {
    return { decision: 'deny', reason: 'contract_default_deny' };
  }
  const match = serverRules.find((r) => r.tool === ev.tool);
  if (match) {
    return { decision: 'allow', reason: 'contract_allow', rule_id: match.id };
  }
  // Server known, tool not in the allowlist.
  return { decision: 'deny', reason: 'contract_enforce_default', rule_id: serverRules[0].id };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function emptyReasonTally(): Record<ContractReason, number> {
  return {
    contract_allow: 0,
    contract_default_deny: 0,
    contract_enforce_default: 0,
    contract_non_default_port: 0,
    contract_invalid_path: 0,
  };
}

/**
 * Replay verified flight sessions through a candidate contract and return the
 * shadow report. Only the contract's own agent's traffic is replayed (contracts
 * are selector-scoped); the sessions may be newer than those compile learned
 * from — replaying against recent traffic is the point.
 */
export function shadowReplay(
  contract: BehavioralContract,
  sessions: FlightSession[],
  opts: ShadowOptions = {},
): ShadowReport {
  const enforceSet = selectEnforceSet(contract, opts);
  const httpRules = enforceSet.filter(isHttp);
  const mcpRules = enforceSet.filter(isMcp);

  const would_block: ShadowVerdict[] = [];
  const by_reason = emptyReasonTally();
  const scopeStats = new Map<string, ShadowScopeStat>();
  let allowed = 0;
  let denied = 0;
  let total = 0;

  const bumpScope = (kind: ShadowScopeStat['scope_kind'], scope: string, decision: ShadowDecision) => {
    const key = `${kind}:${scope}`;
    let s = scopeStats.get(key);
    if (!s) {
      s = { scope_kind: kind, scope, total: 0, allowed: 0, denied: 0 };
      scopeStats.set(key, s);
    }
    s.total++;
    if (decision === 'allow') s.allowed++;
    else s.denied++;
  };

  for (const session of sessions) {
    if (session.agent !== contract.agent) continue;
    for (const { ts, event } of session.events) {
      total++;
      let res: { decision: ShadowDecision; reason: ContractReason; rule_id?: string };
      let scopeKind: ShadowScopeStat['scope_kind'];
      let scope: string;

      if (event.kind === 'http_destination') {
        res = evalHttp(event, httpRules);
        scopeKind = 'http_host';
        scope = event.host;
      } else {
        res = evalMcp(event, mcpRules);
        scopeKind = 'mcp_server';
        scope = event.server;
      }

      bumpScope(scopeKind, scope, res.decision);
      if (res.decision === 'allow') {
        allowed++;
      } else {
        denied++;
        by_reason[res.reason]++;
        would_block.push({
          decision: 'deny',
          reason: res.reason,
          rule_id: res.rule_id,
          session_id: session.session_id,
          ts,
          event,
          observed_only: true,
        });
      }
    }
  }

  const by_scope = [...scopeStats.values()].sort((a, b) =>
    a.scope_kind !== b.scope_kind
      ? a.scope_kind < b.scope_kind
        ? -1
        : 1
      : a.scope < b.scope
        ? -1
        : a.scope > b.scope
          ? 1
          : 0,
  );

  return {
    agent: contract.agent,
    contract_id: contractId(contract),
    enforce_rule_ids: enforceSet.map((r) => r.id).sort(),
    total_events: total,
    allowed,
    denied,
    would_block,
    by_reason,
    by_scope,
  };
}

// ---------------------------------------------------------------------------
// Human-readable shadow report
// ---------------------------------------------------------------------------

function eventLabel(e: FlightEvent): string {
  if (e.kind === 'http_destination') {
    return `${e.method} ${e.scheme}://${e.host}:${e.port}${e.path}`;
  }
  return `mcp ${e.server}/${e.tool}`;
}

/**
 * Render a shadow run for an operator: the headline allow/deny split, the deny
 * breakdown by reason, per-scope effect, and the would-block deltas. This is the
 * artifact read before ratifying (spec anti-pattern: ratifying without seeing
 * the shadow effect).
 */
export function renderShadowReport(report: ShadowReport): string {
  const L: string[] = [];
  L.push(`Shadow replay — agent: ${report.agent}  (observed_only, nothing enforced)`);
  L.push(`contract: ${report.contract_id}`);
  L.push(`enforce-set: ${report.enforce_rule_ids.length} rule(s)`);
  const pct = report.total_events > 0 ? ((report.denied / report.total_events) * 100).toFixed(1) : '0.0';
  L.push(`events: ${report.total_events}   allow: ${report.allowed}   would-block: ${report.denied} (${pct}%)`);
  L.push('');

  L.push('Would-block by reason:');
  for (const reason of CONTRACT_BLOCK_REASONS) {
    const n = report.by_reason[reason];
    if (n > 0) L.push(`  ${reason}: ${n}`);
  }
  if (report.denied === 0) L.push('  (none — contract fully covers replayed traffic)');
  L.push('');

  L.push('Per-scope effect:');
  for (const s of report.by_scope) {
    const flag = s.denied > 0 ? '  ⚠' : '';
    L.push(`  ${s.scope_kind} ${s.scope}: ${s.allowed} allow / ${s.denied} block of ${s.total}${flag}`);
  }
  L.push('');

  if (report.would_block.length > 0) {
    L.push(`Would-block deltas (${report.would_block.length}):`);
    for (const v of report.would_block) {
      const rid = v.rule_id ? `  near=${v.rule_id}` : '';
      L.push(`  [${v.reason}] ${eventLabel(v.event)}${rid}`);
    }
  }
  return L.join('\n');
}
