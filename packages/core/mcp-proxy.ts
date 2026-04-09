#!/usr/bin/env npx tsx
/**
 * mcp-proxy.ts — RAI ActionGate MCP proxy server
 *
 * A transparent MCP proxy that sits between a client (Claude Code, etc.)
 * and a downstream MCP server. Intercepts every tool call, evaluates it
 * against an ActionGate MCP policy, and either forwards or blocks.
 *
 * Usage:
 *   npx tsx mcp-proxy.ts --policy ./policies/my-policy.yaml -- node /path/to/server.js [args...]
 *
 * In claude_desktop_config.json or Claude Code MCP settings:
 *   {
 *     "mcpServers": {
 *       "gated-filesystem": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/mcp-proxy.ts", "--policy", "./policy.yaml", "--", "node", "/path/to/fs-server.js"]
 *       }
 *     }
 *   }
 *
 * The proxy:
 * 1. Spawns the downstream server as a child process (stdio transport)
 * 2. Discovers its tools via listTools()
 * 3. Re-exposes them to the client with ActionGate policy enforcement
 * 4. Forwards allowed calls, returns errors for denied ones
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  evaluateMcp,
  loadMcpPolicy,
  type McpPolicy,
  type McpPolicyYaml,
  type McpToolCall,
} from './action-gate-mcp';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  policyPath: string;
  downstreamCommand: string;
  downstreamArgs: string[];
} {
  const args = argv.slice(2); // skip node + script
  let policyPath = '';
  let separatorIndex = args.indexOf('--');

  if (separatorIndex === -1) {
    process.stderr.write(
      'Usage: mcp-proxy --policy <policy.yaml> -- <downstream-command> [args...]\n',
    );
    process.exit(1);
  }

  for (let i = 0; i < separatorIndex; i++) {
    if (args[i] === '--policy' && i + 1 < separatorIndex) {
      policyPath = args[i + 1];
      i++;
    }
  }

  if (!policyPath) {
    process.stderr.write('Error: --policy <path> is required\n');
    process.exit(1);
  }

  const downstream = args.slice(separatorIndex + 1);
  if (downstream.length === 0) {
    process.stderr.write('Error: downstream command is required after --\n');
    process.exit(1);
  }

  return {
    policyPath,
    downstreamCommand: downstream[0],
    downstreamArgs: downstream.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { policyPath, downstreamCommand, downstreamArgs } = parseArgs(
    process.argv,
  );

  // Load policy
  const policyYaml = yaml.load(
    fs.readFileSync(policyPath, 'utf-8'),
  ) as McpPolicyYaml;
  const policy: McpPolicy = loadMcpPolicy(policyYaml);

  process.stderr.write(
    `[rai-mcp-proxy] policy loaded: ${policy.serverName}, fail_closed=${policy.failClosed}\n`,
  );
  process.stderr.write(
    `[rai-mcp-proxy] downstream: ${downstreamCommand} ${downstreamArgs.join(' ')}\n`,
  );

  // Connect to downstream MCP server
  const downstreamTransport = new StdioClientTransport({
    command: downstreamCommand,
    args: downstreamArgs,
    stderr: 'pipe',
  });

  const downstream = new Client(
    { name: 'rai-actiongate-proxy', version: '0.1.0' },
    { capabilities: {} },
  );

  await downstream.connect(downstreamTransport);
  process.stderr.write('[rai-mcp-proxy] connected to downstream server\n');

  // Discover downstream tools
  const toolsResult = await downstream.listTools();
  const tools = toolsResult.tools;
  process.stderr.write(
    `[rai-mcp-proxy] discovered ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`,
  );

  // Create the proxy server
  const proxy = new McpServer({
    name: `rai-gated-${policy.serverName}`,
    version: '0.1.0',
  });

  // Register each downstream tool with policy enforcement
  for (const tool of tools) {
    // Build zod schema from the tool's inputSchema for McpServer.tool()
    // McpServer expects a zod shape, but we receive JSON Schema from downstream.
    // Workaround: accept any object and pass through to downstream.
    proxy.tool(
      tool.name,
      `[RAI-gated] ${tool.description || tool.name}`,
      // Accept arbitrary arguments -- the downstream server validates
      { _rai_args: z.string().optional().describe('JSON-encoded arguments') },
      async (proxyArgs, extra) => {
        // Reconstruct the original arguments
        // The client sends arguments matching the tool's input schema,
        // which arrive in extra or need to be extracted from the raw request.
        // Since we're using a passthrough schema, we need the raw args.
        // McpServer unwraps based on our declared schema, so we lose the
        // original shape. Use the low-level approach instead.
        return {
          content: [{ type: 'text' as const, text: 'proxy-error: use raw handler' }],
          isError: true,
        };
      },
    );
  }

  // The McpServer high-level API doesn't support passthrough schemas well.
  // Switch to the low-level Server for proper proxying.
  // Let me use a different approach: raw JSON-RPC proxy with policy interception.

  process.stderr.write('[rai-mcp-proxy] starting proxy server\n');

  // Use the low-level protocol approach
  await startRawProxy(downstream, policy, tools);
}

/**
 * Raw JSON-RPC proxy. Reads from stdin, writes to stdout.
 * Intercepts tools/call requests, evaluates against policy.
 * Forwards everything else transparently.
 */
async function startRawProxy(
  downstream: Client,
  policy: McpPolicy,
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] };
    annotations?: Record<string, unknown>;
  }>,
): Promise<void> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin });

  // MCP uses JSON-RPC 2.0 over newline-delimited JSON on stdio
  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };

    try {
      request = JSON.parse(line);
    } catch {
      continue; // Skip malformed lines
    }

    // Handle notifications (no id) -- forward to downstream silently
    if (request.id === undefined) {
      // Notifications don't need responses
      continue;
    }

    try {
      if (request.method === 'initialize') {
        // Return proxy capabilities
        respond(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: `rai-gated-${policy.serverName}`,
            version: '0.1.0',
          },
        });
      } else if (request.method === 'notifications/initialized') {
        // Client ack, no response needed
      } else if (request.method === 'tools/list') {
        // Return tools from downstream, prefixed with gating info
        respond(request.id, {
          tools: tools.map((t) => ({
            ...t,
            description: `[RAI-gated] ${t.description || t.name}`,
          })),
        });
      } else if (request.method === 'tools/call') {
        const toolName = (request.params?.name as string) || '';
        const args = (request.params?.arguments as Record<string, unknown>) || {};

        // ActionGate evaluation
        const call: McpToolCall = {
          kind: 'mcp-tool-call',
          toolName,
          arguments: args,
          serverName: policy.serverName,
        };

        const verdict = evaluateMcp(call, policy);

        if (verdict.decision === 'deny') {
          process.stderr.write(
            `[rai-mcp-proxy] BLOCKED: ${toolName} — ${verdict.reason} (rule: ${verdict.rule})\n`,
          );
          respond(request.id, {
            content: [
              {
                type: 'text',
                text: `[ActionGate L4] Tool call blocked: ${verdict.reason} (rule: ${verdict.rule})`,
              },
            ],
            isError: true,
          });
        } else {
          // Forward to downstream
          const result = await downstream.callTool({ name: toolName, arguments: args });
          respond(request.id, result);
        }
      } else if (request.method === 'ping') {
        respond(request.id, {});
      } else {
        // Unknown method -- return method not found
        respondError(request.id, -32601, `Method not found: ${request.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rai-mcp-proxy] error handling ${request.method}: ${message}\n`);
      respondError(request.id, -32603, message);
    }
  }
}

function respond(id: string | number, result: unknown): void {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function respondError(
  id: string | number,
  code: number,
  message: string,
): void {
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  process.stdout.write(response + '\n');
}

main().catch((err) => {
  process.stderr.write(`[rai-mcp-proxy] fatal: ${err}\n`);
  process.exit(1);
});
