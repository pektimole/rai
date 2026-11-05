/**
 * tools.test.ts — unit tests for the MCP connector tool wrappers.
 *
 * rayScan is mocked so these tests pin the wrapper contract (input shaping,
 * output mapping, error propagation) independently of the P0 pattern battery.
 * evaluateMcp is kept real: the ActionGate wrapper is deterministic and local.
 * No network, no keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { RayScanInput, RayScanOutput, ThreatSignal, McpPolicy } from '@rai/core';

const rayScanMock = vi.fn<(input: RayScanInput) => Promise<RayScanOutput>>();

vi.mock('@rai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rai/core')>();
  return { ...actual, rayScan: (input: RayScanInput) => rayScanMock(input) };
});

const { runScan, runJudge, runActionGate, registerTools, scanInputShape, judgeInputShape, actionGateInputShape } =
  await import('./tools.js');

function signal(over: Partial<ThreatSignal>): ThreatSignal {
  return {
    layer: 'L0',
    label: 'test_label',
    signal: 'test signal',
    severity: 'low',
    matched_pattern: 'secret matched text',
    ...over,
  } as ThreatSignal;
}

function scanOutput(over: Partial<RayScanOutput> = {}): RayScanOutput {
  return {
    scan_id: 'scan-123',
    verdict: 'clean',
    confidence: 0.9,
    threat_layers: [],
    recommended_action: 'pass',
    explanation: 'No threats detected.',
    raw_signals: [],
    ...over,
  } as RayScanOutput;
}

beforeEach(() => {
  rayScanMock.mockReset();
});

// ---------------------------------------------------------------------------
// runScan
// ---------------------------------------------------------------------------

describe('runScan input shaping', () => {
  it('forces is_forward=true and a non-null sender so the principal-user exemption cannot apply', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    await runScan({ content: 'hello' });

    const input = rayScanMock.mock.calls[0][0];
    expect(input.source.is_forward).toBe(true);
    expect(input.source.sender).toBe('mcp-connector');
    expect(input.context.host_environment).toBe('api');
    expect(input.payload).toEqual({ type: 'text', content: 'hello' });
  });

  it('applies defaults for channel, stage, origin_url and session_id', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    await runScan({ content: 'x' });

    const input = rayScanMock.mock.calls[0][0];
    expect(input.source.channel).toBe('browser');
    expect(input.source.pipeline_stage).toBe('ingest');
    expect(input.source.origin_url).toBeNull();
    expect(input.context.session_id).toBe('mcp-anon');
  });

  it('passes caller-provided channel, stage, origin_url and session_id through', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    await runScan({
      content: 'x',
      channel: 'email',
      pipeline_stage: 'output',
      origin_url: 'https://example.com/page',
      session_id: 'sess-42',
    });

    const input = rayScanMock.mock.calls[0][0];
    expect(input.source.channel).toBe('email');
    expect(input.source.pipeline_stage).toBe('output');
    expect(input.source.origin_url).toBe('https://example.com/page');
    expect(input.context.session_id).toBe('sess-42');
  });
});

describe('runScan output mapping', () => {
  it('maps scan output and strips matched_pattern from threat layers', async () => {
    rayScanMock.mockResolvedValue(
      scanOutput({
        verdict: 'flagged',
        confidence: 0.8,
        recommended_action: 'warn',
        explanation: 'found stuff',
        threat_layers: [signal({ layer: 'L0', label: 'inj', signal: 'injection', severity: 'high' })],
      }),
    );
    const out = await runScan({ content: 'x' });

    expect(out.scan_id).toBe('scan-123');
    expect(out.verdict).toBe('flagged');
    expect(out.confidence).toBe(0.8);
    expect(out.recommended_action).toBe('warn');
    expect(out.explanation).toBe('found stuff');
    expect(out.tier_used).toBe('p0');
    expect(out.threat_layers).toEqual([
      { layer: 'L0', label: 'inj', signal: 'injection', severity: 'high' },
    ]);
    expect(out.threat_layers[0]).not.toHaveProperty('matched_pattern');
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('learn_more_url points at /threats when nothing was found', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    const out = await runScan({ content: 'x' });
    expect(out.learn_more_url).toBe('https://ray-ai.com/threats');
  });

  it('learn_more_url deep-links to the highest-severity layer regardless of order', async () => {
    rayScanMock.mockResolvedValue(
      scanOutput({
        verdict: 'blocked',
        threat_layers: [
          signal({ layer: 'L1', severity: 'low' }),
          signal({ layer: 'L-2', severity: 'critical' }),
          signal({ layer: 'L0', severity: 'medium' }),
        ],
      }),
    );
    const out = await runScan({ content: 'x' });
    expect(out.learn_more_url).toBe('https://ray-ai.com/threats/L-2');
  });

  it('ranks an unknown severity below every known one', async () => {
    rayScanMock.mockResolvedValue(
      scanOutput({
        verdict: 'flagged',
        threat_layers: [
          signal({ layer: 'L3', severity: 'bogus' as ThreatSignal['severity'] }),
          signal({ layer: 'L1', severity: 'low' }),
        ],
      }),
    );
    const out = await runScan({ content: 'x' });
    expect(out.learn_more_url).toBe('https://ray-ai.com/threats/L1');
  });

  it('does not mutate the threat_layers array returned by the scanner', async () => {
    const layers = [signal({ layer: 'L1', severity: 'low' }), signal({ layer: 'L0', severity: 'high' })];
    rayScanMock.mockResolvedValue(scanOutput({ verdict: 'flagged', threat_layers: layers }));
    const out = await runScan({ content: 'x' });
    expect(layers.map((l) => l.layer)).toEqual(['L1', 'L0']);
    expect(out.threat_layers.map((l) => l.layer)).toEqual(['L1', 'L0']);
  });

  it('propagates scanner errors to the caller', async () => {
    rayScanMock.mockRejectedValue(new Error('weights missing'));
    await expect(runScan({ content: 'x' })).rejects.toThrow('weights missing');
  });
});

// ---------------------------------------------------------------------------
// runJudge
// ---------------------------------------------------------------------------

describe('runJudge', () => {
  it('always scans at the ingest stage with no origin_url', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    await runJudge({ content: 'x', channel: 'slack', session_id: 's1' });

    const input = rayScanMock.mock.calls[0][0];
    expect(input.source.pipeline_stage).toBe('ingest');
    expect(input.source.origin_url).toBeNull();
    expect(input.source.channel).toBe('slack');
    expect(input.source.is_forward).toBe(true);
    expect(input.context.session_id).toBe('s1');
  });

  it('proceed=true and reason=explanation on clean', async () => {
    rayScanMock.mockResolvedValue(scanOutput({ explanation: 'all good', confidence: 0.95 }));
    const out = await runJudge({ content: 'x' });
    expect(out).toEqual({
      verdict: 'clean',
      proceed: true,
      confidence: 0.95,
      reason: 'all good',
      learn_more_url: 'https://ray-ai.com/threats',
    });
  });

  it.each(['flagged', 'blocked'] as const)('proceed=false on verdict %s', async (verdict) => {
    rayScanMock.mockResolvedValue(
      scanOutput({ verdict, threat_layers: [signal({ label: 'inj', signal: 'instruction override', severity: 'high' })] }),
    );
    const out = await runJudge({ content: 'x' });
    expect(out.proceed).toBe(false);
    expect(out.verdict).toBe(verdict);
  });

  it('reason uses the first threat layer label and signal', async () => {
    rayScanMock.mockResolvedValue(
      scanOutput({
        verdict: 'flagged',
        threat_layers: [
          signal({ label: 'first', signal: 'first signal', severity: 'low' }),
          signal({ label: 'second', signal: 'second signal', severity: 'critical' }),
        ],
      }),
    );
    const out = await runJudge({ content: 'x' });
    expect(out.reason).toBe('first: first signal');
  });

  it('propagates scanner errors to the caller', async () => {
    rayScanMock.mockRejectedValue(new Error('boom'));
    await expect(runJudge({ content: 'x' })).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// runActionGate
// ---------------------------------------------------------------------------

function serverPolicy(over: Partial<McpPolicy> = {}): McpPolicy {
  return {
    serverName: 'srv',
    failClosed: true,
    allowedTools: new Set(['read_file']),
    blockedTools: new Set(),
    blockedArgPatterns: new Map(),
    ...over,
  };
}

describe('runActionGate (caller-advisory mode)', () => {
  it('reports policy_source caller-advisory without a server policy', () => {
    const out = runActionGate({
      action_kind: 'mcp-tool-call',
      tool_name: 'read_file',
      policy: { allowed_tools: ['read_file'] },
    });
    expect(out.policy_source).toBe('caller-advisory');
    expect(out.decision).toBe('allow');
    expect(out.rule).toBe('all-checks-passed');
    expect(out.tool_name).toBe('read_file');
    expect(out.action_kind).toBe('mcp-tool-call');
  });

  it('with no policy at all, defaults to fail-closed and denies', () => {
    const out = runActionGate({ action_kind: 'mcp-tool-call', tool_name: 'anything' });
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('tool-not-in-allowlist');
  });

  it('fail_closed=false allows tools that are not blocked', () => {
    const out = runActionGate({
      action_kind: 'mcp-tool-call',
      tool_name: 'anything',
      policy: { fail_closed: false },
    });
    expect(out.decision).toBe('allow');
  });

  it('fail_closed=false still denies blocked tools', () => {
    const out = runActionGate({
      action_kind: 'mcp-tool-call',
      tool_name: 'rm',
      policy: { fail_closed: false, blocked_tools: ['rm'] },
    });
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('tool-blocked');
  });

  it('denies mcp-tool-call with a missing tool_name', () => {
    const out = runActionGate({ action_kind: 'mcp-tool-call', policy: { fail_closed: false } });
    expect(out).toMatchObject({
      decision: 'deny',
      rule: 'missing-tool-name',
      tool_name: null,
      policy_source: 'caller-advisory',
    });
  });

  it('treats an empty-string tool_name as missing', () => {
    const out = runActionGate({ action_kind: 'mcp-tool-call', tool_name: '', policy: { fail_closed: false } });
    expect(out.rule).toBe('missing-tool-name');
  });

  it.each(['shell', 'fs-git', 'http'] as const)(
    'fails closed on unsupported action_kind %s even with a permissive policy',
    (kind) => {
      const out = runActionGate({
        action_kind: kind,
        tool_name: 'x',
        policy: { fail_closed: false, allowed_tools: ['x'] },
      });
      expect(out.decision).toBe('deny');
      expect(out.rule).toBe('action-kind-unsupported-v0');
      expect(out.action_kind).toBe(kind);
      expect(out.tool_name).toBe('x');
    },
  );

  it('unsupported action_kind without tool_name reports tool_name null', () => {
    const out = runActionGate({ action_kind: 'http' });
    expect(out.tool_name).toBeNull();
  });
});

describe('runActionGate (server policy)', () => {
  it('server policy overrides a permissive caller policy', () => {
    const out = runActionGate(
      {
        action_kind: 'mcp-tool-call',
        tool_name: 'delete_repo',
        policy: { allowed_tools: ['delete_repo'], fail_closed: false },
      },
      serverPolicy(),
    );
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('tool-not-in-allowlist');
    expect(out.policy_source).toBe('server');
  });

  it('server policy denies even when the caller tries to block nothing', () => {
    const out = runActionGate(
      { action_kind: 'mcp-tool-call', tool_name: 'nuke', policy: { blocked_tools: [] } },
      serverPolicy({ blockedTools: new Set(['nuke']), allowedTools: new Set(['nuke']) }),
    );
    expect(out.rule).toBe('tool-blocked');
  });

  it('server policy allows a tool on its allowlist', () => {
    const out = runActionGate({ action_kind: 'mcp-tool-call', tool_name: 'read_file' }, serverPolicy());
    expect(out.decision).toBe('allow');
    expect(out.policy_source).toBe('server');
  });

  it('server-side blocked arg patterns are enforced', () => {
    const out = runActionGate(
      { action_kind: 'mcp-tool-call', tool_name: 'read_file', arguments: { path: '/etc/shadow' } },
      serverPolicy({ blockedArgPatterns: new Map([['*', [/\/etc\/shadow/]]]) }),
    );
    expect(out.decision).toBe('deny');
    expect(out.rule).toBe('blocked-arg-pattern');
  });

  it('reports policy_source server on deny paths that never reach the engine', () => {
    expect(runActionGate({ action_kind: 'shell', tool_name: 'bash' }, serverPolicy()).policy_source).toBe('server');
    expect(runActionGate({ action_kind: 'mcp-tool-call' }, serverPolicy()).policy_source).toBe('server');
  });
});

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

describe('input schemas', () => {
  it('scan schema applies defaults and rejects content over 32k chars', () => {
    const schema = z.object(scanInputShape);
    expect(schema.parse({ content: 'x' })).toMatchObject({
      channel: 'browser',
      pipeline_stage: 'ingest',
      session_id: 'mcp-anon',
    });
    expect(schema.safeParse({ content: 'a'.repeat(32_001) }).success).toBe(false);
    expect(schema.safeParse({ content: 'a'.repeat(32_000) }).success).toBe(true);
  });

  it('scan schema rejects an unknown channel and a missing content', () => {
    const schema = z.object(scanInputShape);
    expect(schema.safeParse({ content: 'x', channel: 'carrier-pigeon' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('judge schema rejects oversize content', () => {
    const schema = z.object(judgeInputShape);
    expect(schema.safeParse({ content: 'a'.repeat(32_001) }).success).toBe(false);
  });

  it('actiongate schema defaults to a fail-closed empty policy', () => {
    const schema = z.object(actionGateInputShape);
    const parsed = schema.parse({ action_kind: 'mcp-tool-call', tool_name: 't' });
    expect(parsed.policy).toEqual({ allowed_tools: [], blocked_tools: [], fail_closed: true });
    expect(parsed.arguments).toEqual({});
    expect(parsed.server_name).toBe('downstream');
  });

  it('actiongate schema rejects an unknown action_kind', () => {
    const schema = z.object(actionGateInputShape);
    expect(schema.safeParse({ action_kind: 'teleport' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

type Handler = (args: any) => Promise<{ content: Array<{ type: string; text: string }> }>;

function fakeServer() {
  const tools = new Map<string, { config: any; handler: Handler }>();
  return {
    tools,
    registerTool(name: string, config: any, handler: Handler) {
      tools.set(name, { config, handler });
    },
  };
}

describe('registerTools', () => {
  it('registers the three tools with titles, descriptions and input schemas', () => {
    const srv = fakeServer();
    registerTools(srv as any);
    expect([...srv.tools.keys()].sort()).toEqual(['rai_actiongate_check', 'rai_judge', 'rai_scan']);
    for (const { config } of srv.tools.values()) {
      expect(config.title).toBeTruthy();
      expect(config.description).toBeTruthy();
      expect(config.inputSchema).toBeTruthy();
    }
  });

  it('rai_scan handler wraps the result as a single JSON text content block', async () => {
    rayScanMock.mockResolvedValue(scanOutput({ scan_id: 'abc' }));
    const srv = fakeServer();
    registerTools(srv as any);
    const res = await srv.tools.get('rai_scan')!.handler({ content: 'x' });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(JSON.parse(res.content[0].text).scan_id).toBe('abc');
  });

  it('rai_judge handler returns proceed in the JSON payload', async () => {
    rayScanMock.mockResolvedValue(scanOutput());
    const srv = fakeServer();
    registerTools(srv as any);
    const res = await srv.tools.get('rai_judge')!.handler({ content: 'x' });
    expect(JSON.parse(res.content[0].text).proceed).toBe(true);
  });

  it('rai_actiongate_check handler uses the server policy when one is registered', async () => {
    const srv = fakeServer();
    registerTools(srv as any, { serverPolicy: serverPolicy() });
    const res = await srv.tools.get('rai_actiongate_check')!.handler({
      action_kind: 'mcp-tool-call',
      tool_name: 'delete_repo',
      policy: { allowed_tools: ['delete_repo'], fail_closed: false },
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.decision).toBe('deny');
    expect(body.policy_source).toBe('server');
  });

  it('rai_actiongate_check handler falls back to caller-advisory without options', async () => {
    const srv = fakeServer();
    registerTools(srv as any);
    const res = await srv.tools.get('rai_actiongate_check')!.handler({
      action_kind: 'mcp-tool-call',
      tool_name: 'read_file',
      policy: { allowed_tools: ['read_file'] },
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.decision).toBe('allow');
    expect(body.policy_source).toBe('caller-advisory');
  });

  it('rai_scan handler rejects when the scanner throws', async () => {
    rayScanMock.mockRejectedValue(new Error('scanner down'));
    const srv = fakeServer();
    registerTools(srv as any);
    await expect(srv.tools.get('rai_scan')!.handler({ content: 'x' })).rejects.toThrow('scanner down');
  });
});
