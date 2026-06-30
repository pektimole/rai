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
import type { McpPolicy } from '@rai/core';
import { registerTools } from './tools.js';

export const VERSION = '0.1.0';

/**
 * Load server-side ActionGate policy from RAI_ACTIONGATE_POLICY env var (JSON).
 *
 * Format:
 *   { "server_name": "...", "fail_closed": true, "allowed_tools": [...], "blocked_tools": [...] }
 *
 * When set, ALL rai_actiongate_check calls use this policy regardless of the
 * inline `policy` argument provided by the calling agent. The caller-provided
 * policy is silently ignored (response includes policy_source: "server").
 *
 * Env: RAI_ACTIONGATE_POLICY — JSON string
 */
function loadServerPolicy(): McpPolicy | undefined {
  const raw = process.env.RAI_ACTIONGATE_POLICY;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      server_name?: string;
      fail_closed?: boolean;
      allowed_tools?: string[];
      blocked_tools?: string[];
    };
    const policy: McpPolicy = {
      serverName: parsed.server_name ?? 'downstream',
      failClosed: parsed.fail_closed ?? true,
      allowedTools: new Set(parsed.allowed_tools ?? []),
      blockedTools: new Set(parsed.blocked_tools ?? []),
      blockedArgPatterns: new Map(),
    };
    process.stdout.write(`[rai-mcp] ActionGate server policy loaded (fail_closed=${policy.failClosed}, allowed=${[...policy.allowedTools].join(',') || '*fail-closed*'})\n`);
    return policy;
  } catch (err) {
    process.stderr.write(`[rai-mcp] WARNING: RAI_ACTIONGATE_POLICY parse error — ActionGate running in caller-advisory mode: ${(err as Error).message}\n`);
    return undefined;
  }
}

const SERVER_POLICY = loadServerPolicy();

const HEALTH = {
  status: 'ok',
  version: VERSION,
  p0: true,
  // Spike is P0-only. P1 (BYOK) + ActionGate-as-LLM land in Phase B.
  p1: false,
  actiongate: true,
  actiongate_policy: SERVER_POLICY ? 'server' : 'caller-advisory',
} as const;

function newMcpServer(): McpServer {
  const server = new McpServer({ name: 'rai', version: VERSION });
  registerTools(server, SERVER_POLICY ? { serverPolicy: SERVER_POLICY } : undefined);
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

// pm2 fork mode loads this file via import() inside ProcessContainerFork.js, so
// process.argv[1] points to the pm2 container, not server.js. Fall back to the
// pm_exec_path env var that pm2 sets to the actual script path.
const runningAsCli =
  typeof process !== 'undefined' &&
  ((process.argv[1] != null &&
    (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) ||
    process.env.pm_exec_path?.endsWith('server.js') === true);

if (runningAsCli) {
  const port = parseInt(process.env.RAI_MCP_PORT ?? '3848', 10);
  const server = createConnectorServer();
  server.listen(port, () => {
    process.stdout.write(`[rai-mcp] listening on :${port}  (POST /mcp, GET /health)\n`);
  });
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
