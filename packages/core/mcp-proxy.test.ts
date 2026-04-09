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

const PROXY_SCRIPT = path.resolve(__dirname, 'mcp-proxy.ts');
const POLICY_PATH = path.resolve(__dirname, 'policies/example-mcp.yaml');
const MOCK_SERVER = path.resolve(__dirname, 'test-fixtures/mock-mcp-server.ts');

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
});
