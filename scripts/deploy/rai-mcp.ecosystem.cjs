/**
 * PM2 ecosystem for the RAI inbound MCP connector (OL-404).
 *
 * Runs the built streamable-HTTP server as a managed process on the VPS,
 * adjacent to ingest-server (3847). Deploy via scripts/deploy/deploy-mcp-connector.sh.
 *
 *   pm2 startOrReload scripts/deploy/rai-mcp.ecosystem.cjs --update-env
 */

const path = require('path');
const repoRoot = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'rai-mcp',
      cwd: repoRoot,
      script: 'packages/mcp-connector/dist/server.js',
      interpreter: 'node',
      env: {
        RAI_MCP_PORT: process.env.RAI_MCP_PORT || '3848',
      },
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
