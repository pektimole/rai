/**
 * contract-compile.ts — Learn-and-lock phase 2: compile (OL-461)
 *
 * Reads verified flight-recorder sessions (the observe phase) and infers a
 * per-agent behavioral contract: the typed allowlist of destinations and tool
 * calls the agent actually exercised. This is the policy-generation layer the
 * VCCE watcher lacks (docs/33-rai-l1-hotreload-spec.md Part A).
 *
 * Three hard requirements from the spec drive the design:
 *
 *  1. Conditional-on-opportunity confidence. A rule is "stable" because
 *     requests WHERE THE OPPORTUNITY EXISTED mostly fit it, not because all
 *     traffic fit it. So an http rule's denominator is events to its
 *     (host, method) — the context where that path could have appeared — never
 *     the global event count. Each rule carries a 95% Wilson lower bound over
 *     that conditional denominator, and cannot be `stable` unless it also
 *     clears the min_sessions / min_events / min_windows floors (so a 5-event
 *     burst in a single session never auto-qualifies).
 *
 *  2. Per-bucket, never-global path normalization. `/users/123` collapses to
 *     `/users/<id>`, bucketed by (host, method, parent-prefix, segment
 *     position) via frequency-weighted entropy. A reserved-segment blocklist
 *     (admin, auth, oauth, token, billing, vault) forbids collapsing sensitive
 *     nouns, so `/admin/*` can never be merged into a `<var>` that also covers
 *     `/users/*`. High-risk siblings stay separate by construction.
 *
 *  3. No silent tail. Events not covered by a stable rule are the host's tail.
 *     When a host's tail exceeds 5% of its events, promotion is blocked unless
 *     the operator explicitly annotates accept_tail — surfaced here, enforced
 *     at ratify time.
 *
 * The contract is emitted unsigned (signature ''); the pipeline signs it with
 * signContract before it can be persisted or promoted, reusing the Ed25519 /
 * canonicalization primitive shared with the L1 manifest and clinical-audit
 * receipts.
 *
 * Spec: docs/33-rai-l1-hotreload-spec.md (Part A, phase 2: compile).
 */

import * as crypto from 'crypto';
import {
  canonicalize,
  keyFingerprint,
  type KeyPair,
} from './l1-manifest.js';
import type { FlightEvent, FlightSession } from './contract-recorder.js';

// ---------------------------------------------------------------------------
// Contract shape
// ---------------------------------------------------------------------------

export type ContractRuleKind = 'http_destination' | 'mcp_tool_call';

/** proposed → capture_only → enforce → expired (or demoted). Compile emits
 *  every rule as `proposed`; the runtime only enforces `enforce`. */
export type RuleLifecycle = 'proposed' | 'capture_only' | 'enforce' | 'expired' | 'demoted';

export interface RuleConfidence {
  matched: number; // events fitting this rule
  opportunities: number; // events where the opportunity existed (conditional denominator)
  wilson_lower: number; // 95% Wilson lower bound of matched/opportunities
  sessions: number; // distinct sessions the rule appeared in
  windows: number; // distinct time windows the rule appeared in
  stable: boolean; // clears the Wilson threshold AND every floor
}

export interface HttpDestinationRule {
  id: string;
  kind: 'http_destination';
  host: string;
  method: string;
  path_template: string; // normalized, e.g. /v1/users/<id>
  schemes: string[];
  ports: number[];
  lifecycle: RuleLifecycle;
  confidence: RuleConfidence;
}

export interface McpToolCallRule {
  id: string;
  kind: 'mcp_tool_call';
  server: string;
  tool: string;
  lifecycle: RuleLifecycle;
  confidence: RuleConfidence;
}

export type ContractRule = HttpDestinationRule | McpToolCallRule;

/** Per-scope (host or mcp server) tail: events not covered by a stable rule. */
export interface TailReport {
  scope_kind: 'http_host' | 'mcp_server';
  scope: string;
  covered_events: number; // events under a stable rule
  total_events: number;
  tail_events: number;
  tail_fraction: number;
  blocks_promotion: boolean; // tail_fraction > threshold && !accept_tail
}

export interface CompileFloors {
  min_sessions: number;
  min_events: number;
  min_windows: number;
  wilson_threshold: number; // Wilson lower bound a rule must clear to be stable
  tail_threshold: number; // max tail fraction before promotion is blocked
}

export const DEFAULT_FLOORS: CompileFloors = {
  min_sessions: 2,
  min_events: 5,
  min_windows: 2,
  wilson_threshold: 0.5,
  tail_threshold: 0.05,
};

export interface BehavioralContract {
  kind: 'behavioral_contract';
  schema_version: 1;
  agent: string; // selector scope — one contract per agent, never shared
  created_at: string; // RFC3339
  key_fingerprint: string; // set at sign time
  floors: CompileFloors;
  rules: ContractRule[];
  tail: TailReport[];
  accept_tail: boolean; // operator annotation carried in from compile options
  promotion_blocked: boolean; // no stable rules, or any tail blocks
  signature: string; // base64 ed25519; '' until signed
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** 95% (z=1.96) Wilson score-interval lower bound for matched/n. 0 when n=0. */
export function wilsonLowerBound(matched: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = matched / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/** Shannon entropy of a frequency vector, normalized to 0..1 by log(distinct).
 *  0 for a single value (no uncertainty), 1 for a uniform distribution. */
export function normalizedEntropy(counts: number[]): number {
  const nonzero = counts.filter((c) => c > 0);
  if (nonzero.length <= 1) return 0;
  const total = nonzero.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const c of nonzero) {
    const pi = c / total;
    h -= pi * Math.log(pi);
  }
  return h / Math.log(nonzero.length);
}

// ---------------------------------------------------------------------------
// Path normalization (per-bucket, entropy-driven, reserved-segment-safe)
// ---------------------------------------------------------------------------

const RESERVED_SEGMENTS = new Set(['admin', 'auth', 'oauth', 'token', 'billing', 'vault']);

const RE_NUMERIC = /^\d+$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_LONGHEX = /^[0-9a-f]{16,}$/i;

function isIdShaped(v: string): boolean {
  return RE_NUMERIC.test(v) || RE_UUID.test(v) || RE_LONGHEX.test(v);
}

/** Placeholder token for a collapsed position, typed by the majority shape. */
function placeholderFor(values: string[]): string {
  if (values.every((v) => RE_NUMERIC.test(v))) return '<id>';
  if (values.every((v) => RE_UUID.test(v))) return '<uuid>';
  if (values.every((v) => RE_LONGHEX.test(v))) return '<hex>';
  return '<var>';
}

export function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

function isPlaceholder(seg: string): boolean {
  return seg.startsWith('<') && seg.endsWith('>');
}

interface NormOptions {
  collapseRatio: number; // distinct/total at a position above which it may collapse
  minEntropy: number; // normalized entropy above which a position may collapse
  idShapeFraction: number; // fraction of distinct values that must be id-shaped to collapse
}

/**
 * Build normalized path templates for a set of paths that already share a
 * (host, method) bucket. Walks the segment trie; at each position decides
 * collapse-to-placeholder vs branch-as-literals using frequency-weighted
 * entropy + a uniqueness ratio + an id-shape gate, and NEVER collapses a
 * position whose values include a reserved segment.
 * Returns template → occurrence count.
 */
export function buildTemplates(paths: string[], opts: NormOptions): Map<string, number> {
  const out = new Map<string, number>();
  walk(paths.map(splitPath), [], out, opts);
  return out;
}

function addCount(out: Map<string, number>, key: string, n: number): void {
  out.set(key, (out.get(key) ?? 0) + n);
}

function templateOf(prefix: string[]): string {
  return '/' + prefix.join('/');
}

function walk(arrs: string[][], prefix: string[], out: Map<string, number>, opts: NormOptions): void {
  const endedHere = arrs.filter((a) => a.length === 0).length;
  if (endedHere > 0) addCount(out, templateOf(prefix), endedHere);

  const cont = arrs.filter((a) => a.length > 0);
  if (cont.length === 0) return;

  const heads = cont.map((a) => a[0]);
  const freq = new Map<string, number>();
  for (const h of heads) freq.set(h, (freq.get(h) ?? 0) + 1);
  const distinct = [...freq.keys()];
  const total = heads.length;

  const anyReserved = distinct.some((v) => RESERVED_SEGMENTS.has(v.toLowerCase()));
  const uniqueness = distinct.length / total;
  const entropy = normalizedEntropy([...freq.values()]);
  const idFraction = distinct.filter(isIdShaped).length / distinct.length;

  const collapse =
    !anyReserved &&
    distinct.length > 1 &&
    uniqueness >= opts.collapseRatio &&
    entropy >= opts.minEntropy &&
    idFraction >= opts.idShapeFraction;

  if (collapse) {
    const ph = placeholderFor(distinct);
    walk(
      cont.map((a) => a.slice(1)),
      [...prefix, ph],
      out,
      opts,
    );
  } else {
    // Branch: keep each head literal (reserved + high-risk siblings stay split).
    for (const v of distinct) {
      walk(
        cont.filter((a) => a[0] === v).map((a) => a.slice(1)),
        [...prefix, v],
        out,
        opts,
      );
    }
  }
}

/** Most specific template (fewest placeholders) that a path matches. Every
 *  path derived into the template set matches at least its own template. */
function bestTemplate(pathSegs: string[], templates: string[]): string | null {
  let best: string | null = null;
  let bestPlaceholders = Infinity;
  for (const t of templates) {
    const tSegs = splitPath(t);
    if (tSegs.length !== pathSegs.length) continue;
    let ok = true;
    let placeholders = 0;
    for (let i = 0; i < tSegs.length; i++) {
      if (isPlaceholder(tSegs[i])) {
        placeholders++;
        continue;
      }
      if (tSegs[i] !== pathSegs[i]) {
        ok = false;
        break;
      }
    }
    if (ok && placeholders < bestPlaceholders) {
      best = t;
      bestPlaceholders = placeholders;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompileOptions {
  floors?: Partial<CompileFloors>;
  collapseRatio?: number; // default 0.5
  minEntropy?: number; // default 0.5
  idShapeFraction?: number; // default 0.8
  windowSize?: 'hour' | 'day'; // default 'hour'
  acceptTail?: boolean; // default false
  createdAt?: string; // deterministic timestamp for tests
}

interface FlatEvent {
  session_id: string;
  ts: string;
  event: FlightEvent;
}

function windowKey(ts: string, size: 'hour' | 'day'): string {
  return size === 'day' ? ts.slice(0, 10) : ts.slice(0, 13);
}

/** Accumulates the observations attributed to one rule. */
interface Accum {
  matched: number;
  sessions: Set<string>;
  windows: Set<string>;
  schemes: Set<string>;
  ports: Set<number>;
}

function newAccum(): Accum {
  return { matched: 0, sessions: new Set(), windows: new Set(), schemes: new Set(), ports: new Set() };
}

/**
 * Compile a per-agent behavioral contract from verified flight sessions. Only
 * sessions whose header agent equals `agent` are used (contracts are
 * selector-scoped; reusing one across agents is an anti-pattern). The result is
 * UNSIGNED — call signContract before persisting or promoting it.
 */
export function compileContract(
  agent: string,
  sessions: FlightSession[],
  opts: CompileOptions = {},
): BehavioralContract {
  const floors: CompileFloors = { ...DEFAULT_FLOORS, ...opts.floors };
  const normOpts: NormOptions = {
    collapseRatio: opts.collapseRatio ?? 0.5,
    minEntropy: opts.minEntropy ?? 0.5,
    idShapeFraction: opts.idShapeFraction ?? 0.8,
  };
  const windowSize = opts.windowSize ?? 'hour';
  const acceptTail = opts.acceptTail ?? false;

  // Flatten matching sessions, tagging each event with its session id.
  const flat: FlatEvent[] = [];
  for (const s of sessions) {
    if (s.agent !== agent) continue;
    for (const e of s.events) flat.push({ session_id: s.session_id, ts: e.ts, event: e.event });
  }

  const rules: ContractRule[] = [];
  const tail: TailReport[] = [];

  // -- HTTP ----------------------------------------------------------------
  const httpByHostMethod = new Map<string, FlatEvent[]>();
  const httpHostTotals = new Map<string, number>();
  for (const f of flat) {
    if (f.event.kind !== 'http_destination') continue;
    const key = `${f.event.host} ${f.event.method}`;
    (httpByHostMethod.get(key) ?? httpByHostMethod.set(key, []).get(key)!).push(f);
    httpHostTotals.set(f.event.host, (httpHostTotals.get(f.event.host) ?? 0) + 1);
  }

  // covered (stable) events per host, for the tail computation.
  const httpHostCovered = new Map<string, number>();

  for (const [key, events] of httpByHostMethod) {
    const [host, method] = key.split(' ');
    const opportunities = events.length;
    const paths = events.map((e) => (e.event as { path: string }).path);
    const templates = buildTemplates(paths, normOpts);
    const templateKeys = [...templates.keys()];

    // Attribute each event to its most-specific template.
    const accums = new Map<string, Accum>();
    for (const f of events) {
      const ev = f.event as Extract<FlightEvent, { kind: 'http_destination' }>;
      const t = bestTemplate(splitPath(ev.path), templateKeys) ?? ev.path;
      const acc = accums.get(t) ?? accums.set(t, newAccum()).get(t)!;
      acc.matched++;
      acc.sessions.add(f.session_id);
      acc.windows.add(windowKey(f.ts, windowSize));
      acc.schemes.add(ev.scheme);
      acc.ports.add(ev.port);
    }

    for (const [template, acc] of accums) {
      const conf = scoreConfidence(acc, opportunities, floors);
      if (conf.stable) httpHostCovered.set(host, (httpHostCovered.get(host) ?? 0) + acc.matched);
      rules.push({
        id: `http:${host}:${method}:${template}`,
        kind: 'http_destination',
        host,
        method,
        path_template: template,
        schemes: [...acc.schemes].sort(),
        ports: [...acc.ports].sort((a, b) => a - b),
        lifecycle: 'proposed',
        confidence: conf,
      });
    }
  }

  for (const [host, total] of httpHostTotals) {
    tail.push(makeTail('http_host', host, httpHostCovered.get(host) ?? 0, total, floors, acceptTail));
  }

  // -- MCP -----------------------------------------------------------------
  const mcpByServerTool = new Map<string, FlatEvent[]>();
  const mcpServerTotals = new Map<string, number>();
  for (const f of flat) {
    if (f.event.kind !== 'mcp_tool_call') continue;
    const key = `${f.event.server} ${f.event.tool}`;
    (mcpByServerTool.get(key) ?? mcpByServerTool.set(key, []).get(key)!).push(f);
    mcpServerTotals.set(f.event.server, (mcpServerTotals.get(f.event.server) ?? 0) + 1);
  }
  const mcpServerCovered = new Map<string, number>();

  for (const [key, events] of mcpByServerTool) {
    const [server, tool] = key.split(' ');
    const opportunities = mcpServerTotals.get(server)!;
    const acc = newAccum();
    for (const f of events) {
      acc.matched++;
      acc.sessions.add(f.session_id);
      acc.windows.add(windowKey(f.ts, windowSize));
    }
    const conf = scoreConfidence(acc, opportunities, floors);
    if (conf.stable) mcpServerCovered.set(server, (mcpServerCovered.get(server) ?? 0) + acc.matched);
    rules.push({
      id: `mcp:${server}:${tool}`,
      kind: 'mcp_tool_call',
      server,
      tool,
      lifecycle: 'proposed',
      confidence: conf,
    });
  }

  for (const [server, total] of mcpServerTotals) {
    tail.push(makeTail('mcp_server', server, mcpServerCovered.get(server) ?? 0, total, floors, acceptTail));
  }

  // Sort rules deterministically by id (stable output across runs).
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tail.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));

  const hasStable = rules.some((r) => r.confidence.stable);
  const tailBlocks = tail.some((t) => t.blocks_promotion);

  return {
    kind: 'behavioral_contract',
    schema_version: 1,
    agent,
    created_at: opts.createdAt ?? new Date().toISOString(),
    key_fingerprint: '',
    floors,
    rules,
    tail,
    accept_tail: acceptTail,
    promotion_blocked: !hasStable || tailBlocks,
    signature: '',
  };
}

function scoreConfidence(acc: Accum, opportunities: number, floors: CompileFloors): RuleConfidence {
  const wilson = wilsonLowerBound(acc.matched, opportunities);
  const sessions = acc.sessions.size;
  const windows = acc.windows.size;
  const stable =
    wilson >= floors.wilson_threshold &&
    sessions >= floors.min_sessions &&
    acc.matched >= floors.min_events &&
    windows >= floors.min_windows;
  return { matched: acc.matched, opportunities, wilson_lower: wilson, sessions, windows, stable };
}

function makeTail(
  scopeKind: TailReport['scope_kind'],
  scope: string,
  covered: number,
  total: number,
  floors: CompileFloors,
  acceptTail: boolean,
): TailReport {
  const tailEvents = total - covered;
  const fraction = total > 0 ? tailEvents / total : 0;
  return {
    scope_kind: scopeKind,
    scope,
    covered_events: covered,
    total_events: total,
    tail_events: tailEvents,
    tail_fraction: fraction,
    blocks_promotion: fraction > floors.tail_threshold && !acceptTail,
  };
}

// ---------------------------------------------------------------------------
// Sign / verify / id  (Ed25519 over canonical form, signature zeroed)
// ---------------------------------------------------------------------------

function signingPreimage(c: BehavioralContract): string {
  return canonicalize({ ...c, signature: '' });
}

/** Content id of a contract (includes signature). Binds a promoted manifest to
 *  the exact contract body — the shared contract-hash primitive of
 *  docs/32-rai-clinical-audit-spec.md. */
export function contractId(c: BehavioralContract): string {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(c), 'utf-8').digest('hex');
}

/** Sign in place: stamps key_fingerprint + signature, returns the same object. */
export function signContract(c: BehavioralContract, keys: KeyPair): BehavioralContract {
  c.key_fingerprint = keyFingerprint(keys.publicKey);
  const sig = crypto.sign(null, Buffer.from(signingPreimage(c), 'utf-8'), keys.privateKey);
  c.signature = sig.toString('base64');
  return c;
}

/** Fail-closed signature check. False on any malformation. */
export function verifyContract(c: BehavioralContract, publicKey: crypto.KeyObject): boolean {
  try {
    if (c.kind !== 'behavioral_contract' || c.schema_version !== 1) return false;
    if (typeof c.signature !== 'string' || c.signature.length === 0) return false;
    if (c.key_fingerprint !== keyFingerprint(publicKey)) return false;
    const sig = Buffer.from(c.signature, 'base64');
    return crypto.verify(null, Buffer.from(signingPreimage(c), 'utf-8'), publicKey, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Human-readable review report (phase 2's second deliverable)
// ---------------------------------------------------------------------------

/** Render a review report an operator reads before ratifying. Never ratify
 *  without reading this (spec anti-pattern). */
export function renderContractReport(c: BehavioralContract): string {
  const L: string[] = [];
  L.push(`Behavioral contract — agent: ${c.agent}`);
  L.push(`created: ${c.created_at}   schema: v${c.schema_version}`);
  L.push(
    `floors: sessions>=${c.floors.min_sessions} events>=${c.floors.min_events} ` +
      `windows>=${c.floors.min_windows} wilson>=${c.floors.wilson_threshold} ` +
      `tail<=${(c.floors.tail_threshold * 100).toFixed(0)}%`,
  );
  L.push(`promotion: ${c.promotion_blocked ? 'BLOCKED' : 'eligible'}${c.accept_tail ? ' (accept_tail)' : ''}`);
  L.push('');

  const stable = c.rules.filter((r) => r.confidence.stable);
  const unstable = c.rules.filter((r) => !r.confidence.stable);

  L.push(`Stable rules (${stable.length}) — eligible to ratify → enforce:`);
  for (const r of stable) L.push('  ' + ruleLine(r));
  L.push('');
  L.push(`Below-floor rules (${unstable.length}) — proposed, NOT eligible until they clear floors:`);
  for (const r of unstable) L.push('  ' + ruleLine(r));
  L.push('');

  L.push('Tail coverage (uncovered = not under a stable rule):');
  for (const t of c.tail) {
    const flag = t.blocks_promotion ? '  ⛔ BLOCKS' : '';
    L.push(
      `  ${t.scope_kind} ${t.scope}: ${t.tail_events}/${t.total_events} tail ` +
        `(${(t.tail_fraction * 100).toFixed(1)}%)${flag}`,
    );
  }
  return L.join('\n');
}

function ruleLine(r: ContractRule): string {
  const c = r.confidence;
  const conf = `w=${c.wilson_lower.toFixed(2)} n=${c.opportunities} m=${c.matched} s=${c.sessions} win=${c.windows}`;
  if (r.kind === 'http_destination') {
    return `${r.method} ${r.schemes.join('|')}://${r.host} ${r.path_template}   [${conf}]`;
  }
  return `mcp ${r.server}/${r.tool}   [${conf}]`;
}
