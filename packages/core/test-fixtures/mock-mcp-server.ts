/**
 * Minimal MCP server for testing the proxy.
 * Exposes two tools: echo (allowed) and delete_file (should be blocked by policy).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'mock-test-server',
  version: '1.0.0',
});

server.tool(
  'echo',
  'Echoes back the input text',
  { text: z.string().describe('Text to echo') },
  async (args) => ({
    content: [{ type: 'text' as const, text: `echo: ${args.text}` }],
  }),
);

server.tool(
  'delete_file',
  'Deletes a file (dangerous)',
  { path: z.string().describe('File path to delete') },
  async (args) => ({
    content: [{ type: 'text' as const, text: `deleted: ${args.path}` }],
  }),
);

server.tool(
  'read_file',
  'Reads a file',
  { path: z.string().describe('File path to read') },
  async (args) => ({
    content: [{ type: 'text' as const, text: `content of ${args.path}` }],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`mock server error: ${err}\n`);
  process.exit(1);
});
