/**
 * server-http.test.ts — HTTP routing, error paths and server-side policy
 * loading for the MCP connector.
 *
 * Binds to 127.0.0.1 on an ephemeral port only; no external network.
 * RAI_ACTIONGATE_POLICY is read at module load, so each policy scenario
 * re-imports server.ts after vi.resetModules().
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type ServerModule = typeof import('./server.js');

async function loadServer(policyEnv?: string): Promise<ServerModule> {
  vi.resetModules();
  if (policyEnv === undefined) delete process.env.RAI_ACTIONGATE_POLICY;
  else process.env.RAI_ACTIONGATE_POLICY = policyEnv;
  return import('./server.js');
}

async function listen(mod: ServerModule): Promise<{ server: Server; baseUrl: string }> {
  const server = mod.createConnectorServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const ORIGINAL_POLICY = process.env.RAI_ACTIONGATE_POLICY;

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_POLICY === undefined) delete process.env.RAI_ACTIONGATE_POLICY;
  else process.env.RAI_ACTIONGATE_POLICY = ORIGINAL_POLICY;
});

describe('HTTP routing and error paths (no server policy)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await loadServer(undefined);
    ({ server, baseUrl } = await listen(mod));
  });

  afterAll(async () => {
    await close(server);
  });

  it('health reports caller-advisory policy mode and p1=false', async () => {
    const body = await (await fetch(`${baseUrl}/health`)).json();
    expect(body.actiongate_policy).toBe('caller-advisory');
    expect(body.p1).toBe(false);
  });

  it('health ignores the query string', async () => {
    const res = await fetch(`${baseUrl}/health?probe=1`);
    expect(res.status).toBe(200);
  });

  it('sets permissive CORS headers on every response', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id');
  });

  it('OPTIONS preflight returns 204 with an empty body', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('non-GET /health returns 405', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method-not-allowed' });
  });

  it.each(['GET', 'DELETE', 'PUT'])('%s /mcp returns 405 with a JSON-RPC error', async (method) => {
    const res = await fetch(`${baseUrl}/mcp`, { method });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    expect(body.id).toBeNull();
  });

  it('POST /mcp with an invalid JSON body returns 400 parse error', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it('unknown paths return 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('rai_judge over the transport returns proceed=true for benign content', async () => {
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const result = await client.callTool({
      name: 'rai_judge',
      arguments: { content: 'Lunch at noon works for me.' },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.proceed).toBe(true);
    await client.close();
  });

  it('rai_actiongate_check over the transport honours an inline policy (advisory mode)', async () => {
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const result = await client.callTool({
      name: 'rai_actiongate_check',
      arguments: {
        action_kind: 'mcp-tool-call',
        tool_name: 'read_file',
        policy: { allowed_tools: ['read_file'] },
      },
    });
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.decision).toBe('allow');
    expect(parsed.policy_source).toBe('caller-advisory');
    await client.close();
  });

  it('a tool call with schema-invalid arguments is reported as an error, not executed', async () => {
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    let errored = false;
    try {
      const result = await client.callTool({
        name: 'rai_scan',
        arguments: { content: 'x', channel: 'carrier-pigeon' },
      });
      errored = result.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    await client.close();
  });
});

describe('server-side ActionGate policy from RAI_ACTIONGATE_POLICY', () => {
  it('loads a valid policy, reports it on /health, and overrides inline policy', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mod = await loadServer(
      JSON.stringify({ server_name: 'srv', fail_closed: true, allowed_tools: ['read_file'], blocked_tools: [] }),
    );
    const { server, baseUrl } = await listen(mod);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.actiongate_policy).toBe('server');

      const client = new Client({ name: 'test-harness', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      const result = await client.callTool({
        name: 'rai_actiongate_check',
        arguments: {
          action_kind: 'mcp-tool-call',
          tool_name: 'delete_repo',
          policy: { allowed_tools: ['delete_repo'], fail_closed: false },
        },
      });
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.decision).toBe('deny');
      expect(parsed.policy_source).toBe('server');
      await client.close();
    } finally {
      await close(server);
    }
  });

  it('falls back to caller-advisory and warns on stderr when the policy JSON is malformed', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mod = await loadServer('{this is not json');
    const { server, baseUrl } = await listen(mod);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.actiongate_policy).toBe('caller-advisory');
      const warned = errSpy.mock.calls.some((c) => String(c[0]).includes('RAI_ACTIONGATE_POLICY parse error'));
      expect(warned).toBe(true);
    } finally {
      await close(server);
    }
  });

  it('an empty env var is treated as no policy', async () => {
    const mod = await loadServer('');
    const { server, baseUrl } = await listen(mod);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.actiongate_policy).toBe('caller-advisory');
    } finally {
      await close(server);
    }
  });
});
