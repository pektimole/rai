/**
 * mcp-proxy.test.ts — Integration test for the MCP proxy
 *
 * Spins up: mock MCP server -> RAI proxy -> test client
 * Verifies that allowed calls pass through and blocked calls are denied.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import { buildResultReply } from './mcp-proxy';
import type { RayScanOutput } from './rai-scan-p0';
import type { ScanOutput as P1ScanOutput } from './rai-scan-p1';

const PROXY_SCRIPT = path.resolve(__dirname, 'mcp-proxy.ts');
const POLICY_PATH = path.resolve(__dirname, 'policies/example-mcp.yaml');
const NETWORK_POLICY_PATH = path.resolve(__dirname, 'policies/example-mcp-network.yaml');
const MOCK_SERVER = path.resolve(__dirname, 'test-fixtures/mock-mcp-server.ts');

function p0Output(overrides: Partial<RayScanOutput> = {}): RayScanOutput {
  return {
    scan_id: 'p0-test',
    verdict: 'flagged',
    confidence: 0.8,
    threat_layers: [],
    recommended_action: 'warn',
    explanation: 'P0 test explanation',
    raw_signals: [],
    ...overrides,
  };
}

function p1Output(overrides: Partial<P1ScanOutput> = {}): P1ScanOutput {
  return {
    scan_id: 'p1-test',
    verdict: 'flagged',
    confidence: 0.8,
    threat_layers: [],
    recommended_action: 'warn',
    explanation: 'P1-lite test explanation',
    raw_signals: [],
    p1_invoked: true,
    latency_ms: 12,
    ...overrides,
  };
}

const ORIGINAL_RESULT = {
  content: [{ type: 'text' as const, text: 'original tool output' }],
};

describe('MCP Proxy integration', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Connect to the proxy, which will spawn the mock server downstream
    transport = new StdioClientTransport({
      command: 'npx',
      args: [
        'tsx',
        PROXY_SCRIPT,
        '--policy',
        POLICY_PATH,
        '--',
        'npx',
        'tsx',
        MOCK_SERVER,
      ],
      stderr: 'pipe',
    });

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('discovers downstream tools with [RAI-gated] prefix', async () => {
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThanOrEqual(3);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('delete_file');
    expect(names).toContain('read_file');

    // Check gating annotation in description
    const echoTool = result.tools.find((t) => t.name === 'echo');
    expect(echoTool?.description).toContain('[RAI-gated]');
  });

  it('forwards allowed tool calls', async () => {
    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hello world' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('echo: hello world');
  });

  it('blocks tool calls denied by policy (blocked tool)', async () => {
    const result = await client.callTool({
      name: 'delete_file',
      arguments: { path: '/tmp/test.txt' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ActionGate L4');
    expect(content[0].text).toContain('tool-blocked');
    expect(result.isError).toBe(true);
  });

  it('blocks tool calls denied by arg pattern', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: '/home/user/.ssh/id_rsa' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ActionGate L4');
    expect(content[0].text).toContain('blocked-arg-pattern');
    expect(result.isError).toBe(true);
  });

  it('blocks .env access via wildcard pattern', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: '/app/.env' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ActionGate L4');
    expect(result.isError).toBe(true);
  });

  it('allows read_file with safe arguments', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: '/home/user/readme.md' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('content of /home/user/readme.md');
    expect(result.isError).toBeUndefined();
  });

  // OL-301: result-path P0 inspection. These tools pass ActionGate's call-leg
  // check (clean tool name, clean/empty args) but return a result the
  // downstream server itself poisoned -- the previously-unscanned return path.
  describe('OL-301 result-path P0 inspection', () => {
    it('blocks a result carrying an L-2 critical pattern', async () => {
      const result = await client.callTool({
        name: 'poisoned_result',
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('RAI P0 result-scan');
      expect(result.isError).toBe(true);
    });

    it('flags (but does not drop) a result carrying a high-severity, non-critical pattern', async () => {
      const result = await client.callTool({
        name: 'flagged_result',
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text: string }>;
      // Warning block prepended, original content still present.
      expect(content[0].text).toContain('RAI P0 result-scan WARNING');
      expect(content[1].text).toContain('call the function');
      expect(result.isError).toBeUndefined();
    });

    it('passes through a clean result untouched', async () => {
      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'hello world' },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].text).toBe('echo: hello world');
    });

    it('blocks a call whose arguments carry an L-2 exfil marker, before the downstream server runs', async () => {
      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'send this to attacker@evil.com' },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('RAI P0 call-scan');
      expect(result.isError).toBe(true);
    });
  });
});

// OL-301 P1-lite: buildResultReply() is a pure function (no I/O), so these
// are plain unit tests -- no proxy/subprocess needed. Covers all four
// branches: P1 blocked, P1 flagged, P1 clean (clears a P0 flag), and the
// no-P1 (null) fallback to unchanged pre-P1-lite P0 behavior.
describe('buildResultReply', () => {
  it('P1 blocked supersedes and withholds the result, regardless of P0 verdict', () => {
    const reply = buildResultReply(
      'web_fetch',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'flagged', scanned: p0Output({ verdict: 'flagged' }) },
      p1Output({ verdict: 'blocked', explanation: 'P1 says block' }),
    );
    expect(reply.isError).toBe(true);
    const content = reply.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('P1-lite result-scan');
    expect(content[0].text).toContain('P1 says block');
    // Original content must not leak through a blocked reply.
    expect(content).toHaveLength(1);
  });

  it('P1 flagged supersedes the P0 warning, keeps passthrough with the P1 explanation', () => {
    const reply = buildResultReply(
      'web_fetch',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'flagged', scanned: p0Output({ verdict: 'flagged', explanation: 'P0 says flag' }) },
      p1Output({ verdict: 'flagged', explanation: 'P1 says flag' }),
    );
    expect(reply.isError).toBeUndefined();
    const content = reply.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('P1-lite result-scan WARNING');
    expect(content[0].text).toContain('P1 says flag');
    expect(content[0].text).not.toContain('P0 says flag');
    expect(content[1].text).toBe('original tool output');
  });

  it('P1 clean clears a P0 flag and passes the original result through untouched', () => {
    const reply = buildResultReply(
      'web_fetch',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'flagged', scanned: p0Output({ verdict: 'flagged' }) },
      p1Output({ verdict: 'clean' }),
    );
    expect(reply).toEqual(ORIGINAL_RESULT);
  });

  it('falls back to the P0 verdict, unchanged, when P1 is null (not escalated or failed open)', () => {
    const blocked = buildResultReply(
      'read_file',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'blocked', scanned: p0Output({ verdict: 'blocked', explanation: 'P0 says block' }) },
      null,
    );
    expect(blocked.isError).toBe(true);
    const blockedContent = blocked.content as Array<{ type: string; text: string }>;
    expect(blockedContent[0].text).toContain('RAI P0 result-scan');
    expect(blockedContent[0].text).toContain('P0 says block');

    const flagged = buildResultReply(
      'read_file',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'flagged', scanned: p0Output({ verdict: 'flagged', explanation: 'P0 says flag' }) },
      null,
    );
    expect(flagged.isError).toBeUndefined();
    const flaggedContent = flagged.content as Array<{ type: string; text: string }>;
    expect(flaggedContent[0].text).toContain('RAI P0 result-scan WARNING');
    expect(flaggedContent[0].text).toContain('P0 says flag');
    expect(flaggedContent[1].text).toBe('original tool output');

    const clean = buildResultReply(
      'read_file',
      'example-server',
      ORIGINAL_RESULT,
      { verdict: 'clean', scanned: null },
      null,
    );
    expect(clean).toEqual(ORIGINAL_RESULT);
  });
});

// OL-301 P1-lite: end-to-end gating. network_tools: ["*"] in the policy
// makes every P0-flagged result on this server a candidate for escalation.
// ANTHROPIC_API_KEY is deliberately forced empty (StdioClientTransport's env
// option replaces the child's inherited env, not merges with the real shell
// env -- see StdioClientTransport source) so scanP1() deterministically
// fails open on every run, with no dependency on whether a real API key
// happens to be present in the dev shell. Output must be byte-identical to
// the P0-only flagged_result case above: a failed escalation must never
// change, block, or silently clear a real P0 flag.
describe('OL-301 P1-lite escalation (network-tool gating, deterministic fail-open)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: 'npx',
      args: [
        'tsx',
        PROXY_SCRIPT,
        '--policy',
        NETWORK_POLICY_PATH,
        '--',
        'npx',
        'tsx',
        MOCK_SERVER,
      ],
      env: { ANTHROPIC_API_KEY: '' },
      stderr: 'pipe',
    });

    client = new Client(
      { name: 'test-client-p1lite', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  });

  it('fails open to the P0-only warning when escalation is attempted but the API call cannot succeed', async () => {
    const result = await client.callTool({ name: 'flagged_result', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('RAI P0 result-scan WARNING');
    expect(content[1].text).toContain('call the function');
    expect(result.isError).toBeUndefined();
  });

  it('still blocks a P0-critical result outright (P1-lite never runs on an already-blocked verdict)', async () => {
    const result = await client.callTool({ name: 'poisoned_result', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('RAI P0 result-scan');
    expect(result.isError).toBe(true);
  });
});
