#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildNovaMcpServer } from '../src/server.js';

/**
 * Stdio MCP server entry for the nova facade. Clients that want a
 * single-pane operator roll-up across the three llamactl-family
 * servers spawn this as a subprocess and speak JSON-RPC over
 * stdin/stdout. Diagnostics go to stderr.
 */

async function main(): Promise<void> {
  const server = buildNovaMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('nova-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`nova-mcp: fatal ${(err as Error).message}\n`);
  process.exit(1);
});
