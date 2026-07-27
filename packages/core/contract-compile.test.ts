/**
 * contract-compile.test.ts — compile phase (OL-461)
 *
 * Proves the three load-bearing invariants of the behavioral-contract compiler:
 *   1. Conditional-on-opportunity confidence — a rule's denominator is events
 *      to its (host, method), not global traffic; floors gate `stable`.
 *   2. Per-bucket path normalization with a reserved-segment blocklist — ids
 *      collapse, sensitive nouns never do, high-risk siblings never merge.
 *   3. No silent tail — a host whose uncovered fraction exceeds 5% blocks
 *      promotion unless accept_tail is set.
 * Plus deterministic Ed25519 sign / fail-closed verify.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './l1-manifest.js';
import type { FlightEvent, FlightSession } from './contract-recorder.js';
import {
  compileContract,
  buildTemplates,
  wilsonLowerBound,
  normalizedEntropy,
  signContract,
  verifyContract,
  renderContractReport,
  DEFAULT_FLOORS,
  type CompileOptions,
} from './contract-compile.js';

// --- session builders ------------------------------------------------------

function http(
  path: string,
  ts: string,
  method = 'GET',
  host = 'api.example.com',
): { ts: string; event: FlightEvent } {
  return { ts, event: { kind: 'http_destination', scheme: 'https', host, port: 443, method, path } };
}

function mcp(server: string, tool: string, ts: string): { ts: string; event: FlightEvent } {
  return { ts, event: { kind: 'mcp_tool_call', server, tool } };
}

function session(
  id: string,
  events: Array<{ ts: string; event: FlightEvent }>,
  agent = 'agent-a',
): FlightSession {
  return { session_id: id, agent, created_at: events[0]?.ts ?? '2026-01-01T00:00:00Z', events };
}

const H0 = '2026-01-01T00:00:00Z';
const H1 = '2026-01-01T01:00:00Z';

/** Eight GET /users/<n> spanning 2 sessions × 2 hour-windows → clears floors. */
function stableUserTraffic() {
  const s1 = session('s1', [
    http('/users/1', H0),
    http('/users/2', H0),
    http('/users/3', H1),
    http('/users/4', H1),
  ]);
  const s2 = session('s2', [
    http('/users/5', H0),
    http('/users/6', H0),
    http('/users/7', H1),
    http('/users/8', H1),
  ]);
  return [s1, s2];
}

const opts = (o: CompileOptions = {}): CompileOptions => ({ createdAt: '2026-01-01T12:00:00Z', ...o });

// --- statistics ------------------------------------------------------------

describe('wilsonLowerBound', () => {
  it('is 0 for no observations', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it('is strictly below the point estimate and rises with n at p=1', () => {
    const small = wilsonLowerBound(3, 3);
    const large = wilsonLowerBound(30, 30);
    expect(small).toBeLessThan(1);
    expect(large).toBeGreaterThan(small); // more evidence → tighter lower bound
    expect(wilsonLowerBound(8, 8)).toBeCloseTo(8 / (8 + 1.96 * 1.96), 6);
  });
  it('drops as the matched fraction drops', () => {
    expect(wilsonLowerBound(5, 10)).toBeLessThan(wilsonLowerBound(9, 10));
  });
});

describe('normalizedEntropy', () => {
  it('is 0 for a single value and 1 for a uniform split', () => {
    expect(normalizedEntropy([7])).toBe(0);
    expect(normalizedEntropy([5, 5])).toBeCloseTo(1, 6);
  });
  it('is between 0 and 1 for a skewed distribution', () => {
    const h = normalizedEntropy([9, 1]);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(1);
  });
});

// --- path normalization ----------------------------------------------------

const NORM = { collapseRatio: 0.5, minEntropy: 0.5, idShapeFraction: 0.8 };

describe('buildTemplates — per-bucket normalization', () => {
  it('collapses a run of numeric ids to a single <id> template', () => {
    const t = buildTemplates(['/users/1', '/users/2', '/users/3', '/users/4', '/users/5'], NORM);
    expect([...t.keys()]).toEqual(['/users/<id>']);
    expect(t.get('/users/<id>')).toBe(5);
  });

  it('types the placeholder by shape (uuid vs id)', () => {
    const ids = [
      '/s/11111111-1111-1111-1111-111111111111',
      '/s/22222222-2222-2222-2222-222222222222',
      '/s/33333333-3333-3333-3333-333333333333',
    ];
    expect([...buildTemplates(ids, NORM).keys()]).toEqual(['/s/<uuid>']);
  });

  it('keeps distinct resource names literal (never collapses words to <var>)', () => {
    const t = buildTemplates(['/users', '/orders', '/health'], NORM);
    expect(new Set(t.keys())).toEqual(new Set(['/users', '/orders', '/health']));
  });

  it('NEVER collapses a position whose values include a reserved segment', () => {
    // Without the blocklist, idShapeFraction 0.8 would collapse this to /a/<id>
    // — which /a/admin would then match. The reserved segment must forbid it.
    const t = buildTemplates(['/a/1', '/a/2', '/a/3', '/a/4', '/a/admin'], NORM);
    expect(t.has('/a/<id>')).toBe(false);
    expect(t.has('/a/admin')).toBe(true);
    expect(t.has('/a/1')).toBe(true);
  });

  it('control: the same shape WITHOUT a reserved sibling does collapse', () => {
    const t = buildTemplates(['/a/1', '/a/2', '/a/3', '/a/4', '/a/5'], NORM);
    expect([...t.keys()]).toEqual(['/a/<id>']);
  });

  it('never merges high-risk siblings — /admin/* stays separate from /users/*', () => {
    const t = buildTemplates(['/admin/1', '/admin/2', '/users/1', '/users/2'], NORM);
    expect(t.has('/admin/<id>')).toBe(true);
    expect(t.has('/users/<id>')).toBe(true);
    // no placeholder at the top position that would span both
    expect([...t.keys()].some((k) => k.startsWith('/<'))).toBe(false);
  });
});

// --- compile: confidence & floors -----------------------------------------

describe('compileContract — conditional-on-opportunity confidence', () => {
  it('marks a well-supported rule stable and scopes its denominator to (host, method)', () => {
    const c = compileContract('agent-a', stableUserTraffic(), opts());
    const rule = c.rules.find((r) => r.kind === 'http_destination' && r.path_template === '/users/<id>');
    expect(rule).toBeDefined();
    expect(rule!.confidence.opportunities).toBe(8); // all GETs to the host — not global
    expect(rule!.confidence.matched).toBe(8);
    expect(rule!.confidence.sessions).toBe(2);
    expect(rule!.confidence.windows).toBe(2);
    expect(rule!.confidence.stable).toBe(true);
    expect(rule!.lifecycle).toBe('proposed'); // compile never emits `enforce`
  });

  it('withholds `stable` when a floor is not met (single session)', () => {
    // Same 8 events but all in one session → min_sessions floor (2) fails.
    const all = [...stableUserTraffic()[0].events, ...stableUserTraffic()[1].events];
    const c = compileContract('agent-a', [session('solo', all)], opts());
    const rule = c.rules.find((r) => r.kind === 'http_destination');
    expect(rule!.confidence.matched).toBe(8);
    expect(rule!.confidence.sessions).toBe(1);
    expect(rule!.confidence.stable).toBe(false); // floor gate, independent of Wilson
    expect(c.promotion_blocked).toBe(true); // no stable rules
  });

  it('withholds `stable` when Wilson is low even if floors pass', () => {
    // Opportunity denominator large, matched small: the template accounts for
    // only a minority of GETs to the host → low Wilson lower bound.
    const noise = Array.from({ length: 20 }, (_, i) =>
      http(`/search/q${i}x${i}`, i % 2 ? H1 : H0),
    ); // 20 distinct non-id-ish paths, mostly singletons
    const s1 = session('s1', [http('/users/1', H0), http('/users/2', H1), ...noise.slice(0, 10)]);
    const s2 = session('s2', [http('/users/3', H0), http('/users/4', H1), ...noise.slice(10)]);
    const c = compileContract('agent-a', [s1, s2], opts());
    const users = c.rules.find((r) => r.kind === 'http_destination' && r.path_template === '/users/<id>');
    expect(users!.confidence.matched).toBe(4);
    expect(users!.confidence.opportunities).toBe(24); // conditional denom includes the noise
    expect(users!.confidence.wilson_lower).toBeLessThan(DEFAULT_FLOORS.wilson_threshold);
    expect(users!.confidence.stable).toBe(false);
  });
});

// --- compile: tail coverage -----------------------------------------------

describe('compileContract — no silent tail', () => {
  function trafficWithTail() {
    // 8 stable /users/<id> + 1 uncovered /health on the same host.
    const [s1, s2] = stableUserTraffic();
    s1.events.push(http('/health', H0));
    return [s1, s2];
  }

  it('blocks promotion when a host tail exceeds 5%', () => {
    const c = compileContract('agent-a', trafficWithTail(), opts());
    const tail = c.tail.find((t) => t.scope === 'api.example.com');
    expect(tail!.total_events).toBe(9);
    expect(tail!.covered_events).toBe(8); // only the stable /users/<id> rule counts
    expect(tail!.tail_events).toBe(1);
    expect(tail!.tail_fraction).toBeCloseTo(1 / 9, 6);
    expect(tail!.blocks_promotion).toBe(true);
    expect(c.promotion_blocked).toBe(true);
  });

  it('accept_tail overrides the tail gate (operator opt-in)', () => {
    const c = compileContract('agent-a', trafficWithTail(), opts({ acceptTail: true }));
    const tail = c.tail.find((t) => t.scope === 'api.example.com');
    expect(tail!.blocks_promotion).toBe(false);
    expect(c.accept_tail).toBe(true);
    expect(c.promotion_blocked).toBe(false); // a stable rule exists and the tail is accepted
  });
});

// --- compile: mcp + scoping ------------------------------------------------

describe('compileContract — mcp rules and agent scoping', () => {
  it('compiles per-(server,tool) rules with server-scoped denominators', () => {
    const s1 = session('s1', [
      mcp('gmail', 'search', H0),
      mcp('gmail', 'search', H0),
      mcp('gmail', 'search', H1),
      mcp('gmail', 'search', H1),
    ]);
    const s2 = session('s2', [
      mcp('gmail', 'search', H0),
      mcp('gmail', 'search', H0),
      mcp('gmail', 'search', H1),
      mcp('gmail', 'search', H1),
      mcp('gmail', 'send', H0),
    ]);
    const c = compileContract('agent-a', [s1, s2], opts());
    const search = c.rules.find((r) => r.kind === 'mcp_tool_call' && r.tool === 'search');
    expect(search!.confidence.matched).toBe(8);
    expect(search!.confidence.opportunities).toBe(9); // all gmail calls — server-scoped
    expect(search!.confidence.sessions).toBe(2);
    expect(search!.confidence.stable).toBe(true);
    const send = c.rules.find((r) => r.kind === 'mcp_tool_call' && r.tool === 'send');
    expect(send!.confidence.stable).toBe(false); // one-off, below floors
  });

  it('ignores sessions belonging to a different agent', () => {
    const mine = stableUserTraffic();
    const theirs = session('x', [http('/leak/1', H0), http('/leak/2', H1)], 'agent-b');
    const c = compileContract('agent-a', [...mine, theirs], opts());
    expect(c.rules.some((r) => r.kind === 'http_destination' && r.host === 'api.example.com')).toBe(true);
    expect(c.rules.every((r) => !(r.kind === 'http_destination' && r.path_template.includes('leak')))).toBe(true);
  });
});

// --- signing ---------------------------------------------------------------

describe('signContract / verifyContract', () => {
  it('round-trips a signature and detects tampering (fail-closed)', () => {
    const keys = generateKeyPair();
    const c = signContract(compileContract('agent-a', stableUserTraffic(), opts()), keys);
    expect(c.signature.length).toBeGreaterThan(0);
    expect(c.key_fingerprint.length).toBeGreaterThan(0);
    expect(verifyContract(c, keys.publicKey)).toBe(true);

    const tampered = structuredClone(c);
    tampered.rules[0].confidence.stable = !tampered.rules[0].confidence.stable;
    expect(verifyContract(tampered, keys.publicKey)).toBe(false);
  });

  it('rejects an unsigned contract', () => {
    const keys = generateKeyPair();
    const c = compileContract('agent-a', stableUserTraffic(), opts());
    expect(verifyContract(c, keys.publicKey)).toBe(false);
  });

  it('is deterministic — same input compiles byte-identically', () => {
    const a = compileContract('agent-a', stableUserTraffic(), opts());
    const b = compileContract('agent-a', stableUserTraffic(), opts());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// --- report ----------------------------------------------------------------

describe('renderContractReport', () => {
  it('summarizes stable rules, floors, and tail status', () => {
    const c = compileContract('agent-a', stableUserTraffic(), opts());
    const report = renderContractReport(c);
    expect(report).toMatch(/agent: agent-a/);
    expect(report).toMatch(/Stable rules \(1\)/);
    expect(report).toMatch(/\/users\/<id>/);
    expect(report).toMatch(/promotion: eligible/);
  });
});
