#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildNovaMcpServer } from '../src/server.js';
import { loadConfig } from '../src/facade/config.js';
import { bootAll, closeAll, type Downstream } from '../src/facade/downstream.js';

/**
 * Stdio MCP server entry for the nova facade. Clients that want a
 * single-pane operator roll-up across the three llamactl-family
 * servers spawn this as a subprocess and speak JSON-RPC over
 * stdin/stdout. Diagnostics go to stderr.
 *
 * Phase 2: boots the facade infrastructure — loads
 * `~/.llamactl/nova-mcp.yaml` (or `$NOVA_MCP_CONFIG`) and opens MCP
 * client connections to each configured downstream. Missing config
 * is fine; the facade still serves its native `nova.*` tools. Phase
 * 3 will read `downstreams` and re-advertise their tool surfaces on
 * the nova server.
 */

// Phase-2 stash — proxy layer (Phase 3) will move this into the
// server builder's context; keeping it module-scoped keeps the
// wiring minimal for now.
let downstreams: Downstream[] = [];

async function main(): Promise<void> {
  const server = buildNovaMcpServer();

  let config: Awaited<ReturnType<typeof loadConfig>> = null;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`nova-mcp: facade config error — ${(err as Error).message}\n`);
  }
  downstreams = await bootAll(config);

  const nativeToolCount = 4;
  process.stderr.write(
    `nova-mcp: facade ready — ${downstreams.length} downstreams connected, ${nativeToolCount} native tools.\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`nova-mcp: ${signal} received, closing ${downstreams.length} downstreams\n`);
    await closeAll(downstreams);
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('nova-mcp: ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`nova-mcp: fatal ${(err as Error).message}\n`);
  process.exit(1);
});
