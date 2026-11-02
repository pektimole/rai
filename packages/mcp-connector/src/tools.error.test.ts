/**
 * tools.error.test.ts — error propagation when the @rai/core scanner fails.
 *
 * rayScan is replaced with a mock so the failure path can be forced
 * deterministically. Uses an in-memory MCP transport (no sockets, no network).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@rai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rai/core')>();
  return { ...actual, rayScan: vi.fn() };
});

import { rayScan } from '@rai/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, runJudge, runScan, runActionGate } from './tools.js';

const mockedScan = vi.mocked(rayScan);

describe('scanner failure', () => {
  beforeEach(() => {
    mockedScan.mockReset();
    mockedScan.mockRejectedValue(new Error('scanner unavailable'));
  });

  it('runScan propagates the scanner error', async () => {
    await expect(runScan({ content: 'x' })).rejects.toThrow('scanner unavailable');
  });

  it('runJudge propagates the scanner error (never silently proceeds)', async () => {
    await expect(runJudge({ content: 'x' })).rejects.toThrow('scanner unavailable');
  });

  it('runActionGate does not depend on the scanner', () => {
    const out = runActionGate({
      action_kind: 'mcp-tool-call',
      tool_name: 'read_file',
      policy: { allowed_tools: ['read_file'] },
    });
    expect(out.decision).toBe('allow');
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it('surfaces the failure to MCP clients as an error result', async () => {
    const server = new McpServer({ name: 'rai-test', version: '0.0.0' });
    registerTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      for (const name of ['rai_scan', 'rai_judge']) {
        const result = await client.callTool({ name, arguments: { content: 'x' } });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ text: string }>)[0].text;
        expect(text).toContain('scanner unavailable');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('scanner output mapping', () => {
  it('passes connector content to rayScan as untrusted forwarded input', async () => {
    mockedScan.mockReset();
    mockedScan.mockResolvedValue({
      scan_id: 'scan-1',
      verdict: 'flagged',
      confidence: 0.7,
      recommended_action: 'warn',
      threat_layers: [
        { layer: 'L0', label: 'Prompt injection', signal: 'low', severity: 'low' },
        { layer: 'L-2', label: 'Infrastructure', signal: 'high', severity: 'critical' },
      ],
      explanation: 'two signals',
    } as never);

    const out = await runScan({ content: 'payload', channel: 'email', session_id: 's-9' });

    const input = mockedScan.mock.calls[0][0];
    expect(input.source).toMatchObject({
      channel: 'email',
      pipeline_stage: 'ingest',
      sender: 'mcp-connector',
      origin_url: null,
      is_forward: true,
    });
    expect(input.payload).toEqual({ type: 'text', content: 'payload' });
    expect(input.context).toMatchObject({ session_id: 's-9', host_environment: 'api' });

    expect(out.scan_id).toBe('scan-1');
    expect(out.learn_more_url).toBe('https://ray-ai.com/threats/L-2');

    const judged = await runJudge({ content: 'payload' });
    expect(judged.proceed).toBe(false);
    expect(judged.reason).toBe('Prompt injection: low');
  });
});
