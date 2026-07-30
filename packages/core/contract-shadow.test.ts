/**
 * contract-shadow.test.ts — shadow replay (OL-461, phase 3)
 *
 * Proves the dry-run allowlist semantics of a candidate contract: the two-level
 * jurisdiction (default_deny vs enforce_default), the named port/path reasons,
 * replay-strict typed placeholder matching (`/users/<id>` must NOT admit
 * `/users/admin`), that only the enforce-set participates (unstable rules do not
 * block traffic in), agent scoping, and that nothing is ever enforced
 * (observed_only). Contracts are built through the real compiler so the replay
 * runs against genuinely-inferred rules.
 */

import { describe, it, expect } from 'vitest';
import {
  compileContract,
  contractId,
  type BehavioralContract,
} from './contract-compile.js';
import {
  shadowReplay,
  renderShadowReport,
  CONTRACT_BLOCK_REASONS,
  type ShadowReport,
} from './contract-shadow.js';
import type { FlightEvent, FlightSession } from './contract-recorder.js';

// --- fixtures --------------------------------------------------------------

const H0 = '2026-01-01T00';
const H1 = '2026-01-01T01';

interface Over {
  method?: string;
  host?: string;
  scheme?: string;
  port?: number;
}

function http(path: string, ts: string, o: Over = {}): { ts: string; event: FlightEvent } {
  return {
    ts,
    event: {
      kind: 'http_destination',
      scheme: o.scheme ?? 'https',
      host: o.host ?? 'api.example.com',
      port: o.port ?? 443,
      method: o.method ?? 'GET',
      path,
    },
  };
}

function mcp(server: string, tool: string, ts: string): { ts: string; event: FlightEvent } {
  return { ts, event: { kind: 'mcp_tool_call', server, tool } };
}

function session(
  id: string,
  events: Array<{ ts: string; event: FlightEvent }>,
  agent = 'agent-a',
): FlightSession {
  return { session_id: id, agent, created_at: `${H0}:00:00Z`, events };
}

/** 8 GET /users/<n> over 2 sessions × 2 hour windows → a stable /users/<id>
 *  rule. Plus a gmail/search rule stable at 8/9, and a one-off gmail/send that
 *  stays below floor (unstable). */
function learnedContract(): BehavioralContract {
  const sessions: FlightSession[] = [
    session('h1', [
      http('/users/1', `${H0}:00:00Z`),
      http('/users/2', `${H0}:05:00Z`),
      http('/users/3', `${H1}:00:00Z`),
      http('/users/4', `${H1}:05:00Z`),
    ]),
    session('h2', [
      http('/users/5', `${H0}:10:00Z`),
      http('/users/6', `${H0}:15:00Z`),
      http('/users/7', `${H1}:10:00Z`),
      http('/users/8', `${H1}:15:00Z`),
    ]),
    session('m1', [
      mcp('gmail', 'search', `${H0}:00:00Z`),
      mcp('gmail', 'search', `${H0}:05:00Z`),
      mcp('gmail', 'search', `${H1}:00:00Z`),
      mcp('gmail', 'search', `${H1}:05:00Z`),
    ]),
    session('m2', [
      mcp('gmail', 'search', `${H0}:10:00Z`),
      mcp('gmail', 'search', `${H0}:15:00Z`),
      mcp('gmail', 'search', `${H1}:10:00Z`),
      mcp('gmail', 'search', `${H1}:15:00Z`),
      mcp('gmail', 'send', `${H1}:20:00Z`),
    ]),
  ];
  return compileContract('agent-a', sessions, { createdAt: `${H0}:00:00Z` });
}

// --- the contract we replay against ---------------------------------------

describe('learnedContract fixture', () => {
  it('has stable /users/<id> and gmail/search rules, unstable gmail/send', () => {
    const c = learnedContract();
    const users = c.rules.find((r) => r.id === 'http:api.example.com:GET:/users/<id>');
    const search = c.rules.find((r) => r.id === 'mcp:gmail:search');
    const send = c.rules.find((r) => r.id === 'mcp:gmail:send');
    expect(users?.confidence.stable).toBe(true);
    expect(search?.confidence.stable).toBe(true);
    expect(send?.confidence.stable).toBe(false);
  });
});

// --- allow -----------------------------------------------------------------

describe('shadowReplay — allow path', () => {
  it('allows traffic matching a stable rule and blocks nothing', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [
      session('r', [http('/users/999', `${H0}:30:00Z`), mcp('gmail', 'search', `${H0}:31:00Z`)]),
    ]);
    expect(report.total_events).toBe(2);
    expect(report.allowed).toBe(2);
    expect(report.denied).toBe(0);
    expect(report.would_block).toHaveLength(0);
  });
});

// --- two-level jurisdiction ------------------------------------------------

describe('shadowReplay — jurisdiction', () => {
  it('default_deny for a host the contract never observed', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/x', `${H0}:30:00Z`, { host: 'evil.test' })])]);
    expect(report.denied).toBe(1);
    expect(report.by_reason.contract_default_deny).toBe(1);
    expect(report.would_block[0].rule_id).toBeUndefined();
    expect(report.would_block[0].observed_only).toBe(true);
  });

  it('enforce_default for a known host with an unobserved path shape', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/orders/1', `${H0}:30:00Z`)])]);
    expect(report.by_reason.contract_enforce_default).toBe(1);
    expect(report.would_block[0].rule_id).toBe('http:api.example.com:GET:/users/<id>');
  });
});

// --- typed placeholder (replay-strict) ------------------------------------

describe('shadowReplay — typed placeholder matching', () => {
  it('a numeric <id> rule does NOT admit /users/admin', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/users/admin', `${H0}:30:00Z`)])]);
    // 'admin' is not numeric → no rule matches → host known → enforce_default.
    expect(report.allowed).toBe(0);
    expect(report.by_reason.contract_enforce_default).toBe(1);
  });

  it('admits a fresh numeric id under the same <id> rule', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/users/40404', `${H0}:30:00Z`)])]);
    expect(report.allowed).toBe(1);
    expect(report.denied).toBe(0);
  });
});

// --- named port / scheme / path reasons ------------------------------------

describe('shadowReplay — shape reasons', () => {
  it('non_default_port when the path fits but the port was never observed', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/users/7', `${H0}:30:00Z`, { port: 8443 })])]);
    expect(report.by_reason.contract_non_default_port).toBe(1);
    expect(report.would_block[0].rule_id).toBe('http:api.example.com:GET:/users/<id>');
  });

  it('enforce_default on a scheme downgrade at the observed port', () => {
    const c = learnedContract();
    // port 443 is allowed, but https→http is a shape the recorder never saw.
    const report = shadowReplay(c, [session('r', [http('/users/7', `${H0}:30:00Z`, { scheme: 'http' })])]);
    expect(report.by_reason.contract_enforce_default).toBe(1);
  });

  it('invalid_path for a non-canonical path (traversal)', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/users/../admin', `${H0}:30:00Z`)])]);
    expect(report.by_reason.contract_invalid_path).toBe(1);
  });
});

// --- MCP --------------------------------------------------------------------

describe('shadowReplay — MCP', () => {
  it('allows a stable tool, default_deny an unknown server, enforce_default an unstable tool', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [
      session('r', [
        mcp('gmail', 'search', `${H0}:30:00Z`), // allow (stable)
        mcp('slack', 'post', `${H0}:31:00Z`), // default_deny (server unseen)
        mcp('gmail', 'send', `${H0}:32:00Z`), // enforce_default (send is unstable → not enforced)
      ]),
    ]);
    expect(report.allowed).toBe(1);
    expect(report.by_reason.contract_default_deny).toBe(1);
    expect(report.by_reason.contract_enforce_default).toBe(1);
  });
});

// --- only the enforce-set participates ------------------------------------

describe('shadowReplay — enforce-set selection', () => {
  it('an empty enforce set denies everything as default_deny', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/users/1', `${H0}:30:00Z`)])], {
      enforceRuleIds: [],
    });
    expect(report.enforce_rule_ids).toHaveLength(0);
    expect(report.by_reason.contract_default_deny).toBe(1);
  });

  it('an explicit subset enforces only the named rules', () => {
    const c = learnedContract();
    const report = shadowReplay(
      c,
      [
        session('r', [
          mcp('gmail', 'search', `${H0}:30:00Z`), // allowed by the named rule
          http('/users/1', `${H0}:31:00Z`), // http not in the set → default_deny
        ]),
      ],
      { enforceRuleIds: ['mcp:gmail:search'] },
    );
    expect(report.enforce_rule_ids).toEqual(['mcp:gmail:search']);
    expect(report.allowed).toBe(1);
    expect(report.by_reason.contract_default_deny).toBe(1);
  });
});

// --- agent scoping ---------------------------------------------------------

describe('shadowReplay — agent scoping', () => {
  it('ignores sessions belonging to another agent', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [
      session('other', [http('/users/1', `${H0}:30:00Z`)], 'agent-b'),
    ]);
    expect(report.total_events).toBe(0);
    expect(report.allowed).toBe(0);
    expect(report.denied).toBe(0);
  });
});

// --- report shape + render -------------------------------------------------

describe('shadow report + render', () => {
  it('binds to the exact contract id and tallies scope + reasons', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [
      session('r', [
        http('/users/1', `${H0}:30:00Z`), // allow
        http('/orders/1', `${H0}:31:00Z`), // enforce_default
      ]),
    ]);
    expect(report.contract_id).toBe(contractId(c));
    const host = report.by_scope.find((s) => s.scope === 'api.example.com');
    expect(host).toMatchObject({ total: 2, allowed: 1, denied: 1 });
    // by_reason spans exactly the four block reasons plus the allow annotation.
    for (const r of CONTRACT_BLOCK_REASONS) expect(report.by_reason[r]).toBeGreaterThanOrEqual(0);
  });

  it('renders an operator-readable summary', () => {
    const c = learnedContract();
    const report = shadowReplay(c, [session('r', [http('/orders/1', `${H0}:30:00Z`)])]);
    const text = renderShadowReport(report);
    expect(text).toContain('observed_only');
    expect(text).toContain('contract_enforce_default');
    expect(text).toContain(report.contract_id);
  });
});
