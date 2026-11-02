/**
 * http.test.ts — HTTP routing and error handling of the connector server,
 * plus RAI_ACTIONGATE_POLICY loading.
 *
 * The server listens on 127.0.0.1 with an ephemeral port; all requests stay on
 * the loopback interface. No external network calls.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type ServerModule = typeof import('./server.js');

async function loadServerModule(policyEnv?: string): Promise<ServerModule> {
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

describe('HTTP routing and errors', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await listen(await loadServerModule()));
  });

  afterAll(async () => {
    await close(server);
  });

  it('answers CORS preflight with 204 and permissive headers', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('reports caller-advisory mode in /health when no server policy is set', async () => {
    const res = await fetch(`${baseUrl}/health?probe=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toMatchObject({ p1: false, actiongate_policy: 'caller-advisory' });
  });

  it('rejects non-GET on /health with 405', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method-not-allowed' });
  });

  it('rejects GET on /mcp with a JSON-RPC 405', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
    expect(body.id).toBeNull();
  });

  it('rejects a malformed JSON body with a JSON-RPC parse error (400)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc": "2.0", "method": ',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('does not answer a POST with an empty body as a successful MCP call', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('serves rai_actiongate_check and rai_judge over streamable HTTP', async () => {
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    try {
      const gate = await client.callTool({
        name: 'rai_actiongate_check',
        arguments: { action_kind: 'mcp-tool-call', tool_name: 'write_file' },
      });
      const gateOut = JSON.parse((gate.content as Array<{ text: string }>)[0].text);
      expect(gateOut).toMatchObject({ decision: 'deny', policy_source: 'caller-advisory' });

      const judge = await client.callTool({
        name: 'rai_judge',
        arguments: { content: 'Lunch at noon?' },
      });
      const judgeOut = JSON.parse((judge.content as Array<{ text: string }>)[0].text);
      expect(judgeOut.proceed).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('RAI_ACTIONGATE_POLICY', () => {
  afterEach(() => {
    delete process.env.RAI_ACTIONGATE_POLICY;
    vi.restoreAllMocks();
  });

  it('enforces the server policy over a permissive inline policy', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mod = await loadServerModule(
      JSON.stringify({ server_name: 'locked', allowed_tools: ['read_file'] }),
    );
    const { server, baseUrl } = await listen(mod);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.actiongate_policy).toBe('server');

      const client = new Client({ name: 'test-harness', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      try {
        const res = await client.callTool({
          name: 'rai_actiongate_check',
          arguments: {
            action_kind: 'mcp-tool-call',
            tool_name: 'delete_repo',
            policy: { allowed_tools: ['delete_repo'], fail_closed: false },
          },
        });
        const out = JSON.parse((res.content as Array<{ text: string }>)[0].text);
        expect(out).toMatchObject({ decision: 'deny', policy_source: 'server' });

        const ok = await client.callTool({
          name: 'rai_actiongate_check',
          arguments: { action_kind: 'mcp-tool-call', tool_name: 'read_file' },
        });
        const okOut = JSON.parse((ok.content as Array<{ text: string }>)[0].text);
        expect(okOut).toMatchObject({ decision: 'allow', policy_source: 'server' });
      } finally {
        await client.close();
      }
    } finally {
      await close(server);
    }
  });

  it('falls back to caller-advisory mode and warns on malformed JSON', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mod = await loadServerModule('{not json');
    const { server, baseUrl } = await listen(mod);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.actiongate_policy).toBe('caller-advisory');
      expect(stderr.mock.calls.some(([msg]) => String(msg).includes('RAI_ACTIONGATE_POLICY parse error'))).toBe(true);
    } finally {
      await close(server);
    }
  });
});
