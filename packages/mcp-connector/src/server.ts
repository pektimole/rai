/**
 * server.ts — RAI inbound MCP server (Option A spike).
 *
 * Exposes rai_scan / rai_judge / rai_actiongate_check to Claude Code over the
 * MCP streamable-HTTP transport, plus a plain GET /health for uptime monitoring.
 *
 * Stateless mode: every POST /mcp gets a fresh McpServer + transport. No session
 * state, no auth, no telemetry (those are Phase B / spec §4–5). One URL a user
 * pastes into Claude Code settings.
 *
 * Spec: docs/34-rai-mcp-connector-spec.md §6 (deployment), §8 Option A.
 *
 * Env:
 *   RAI_MCP_PORT — TCP port (default 3848, adjacent to ingest-server 3847)
 */

import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

export const VERSION = '0.1.0';

const HEALTH = {
  status: 'ok',
  version: VERSION,
  p0: true,
  // Spike is P0-only. P1 (BYOK) + ActionGate-as-LLM land in Phase B.
  p1: false,
  actiongate: true,
} as const;

function newMcpServer(): McpServer {
  const server = new McpServer({ name: 'rai', version: VERSION });
  registerTools(server);
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createConnectorServer(): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0];

  // CORS (permissive for the spike; tightened in Phase B).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Health: plain HTTP, NOT an MCP tool (spec §3 "Not MCP tools") ---
  if (url === '/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(HEALTH));
    return;
  }

  // --- MCP endpoint ---
  if (url === '/mcp') {
    if (req.method !== 'POST') {
      // Stateless mode: no standalone SSE stream / session teardown.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed. Use POST for stateless MCP.' },
          id: null,
        }),
      );
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: body is not valid JSON.' },
          id: null,
        }),
      );
      return;
    }

    const server = newMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
            id: null,
          }),
        );
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const runningAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (runningAsCli) {
  const port = parseInt(process.env.RAI_MCP_PORT ?? '3848', 10);
  const server = createConnectorServer();
  server.listen(port, () => {
    process.stdout.write(`[rai-mcp] listening on :${port}  (POST /mcp, GET /health)\n`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
