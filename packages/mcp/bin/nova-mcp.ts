#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildNovaMcpServer } from '../src/server.js';
import { loadConfig } from '../src/facade/config.js';
import { bootAll, closeAll, type Downstream } from '../src/facade/downstream.js';
import { mountProxyTools } from '../src/facade/proxy.js';
import { registerUnifiedTools } from '../src/tools/unified.js';

/**
 * Stdio MCP server entry for the nova facade. Clients that want a
 * single-pane operator roll-up across the three llamactl-family
 * servers spawn this as a subprocess and speak JSON-RPC over
 * stdin/stdout. Diagnostics go to stderr.
 *
 * Phase 2: boots the facade infrastructure — loads
 * `~/.llamactl/nova-mcp.yaml` (or `$NOVA_MCP_CONFIG`) and opens MCP
 * client connections to each configured downstream. Missing config
 * is fine; the facade still serves its native `nova.*` tools.
 *
 * Phase 3: `mountProxyTools` snapshots each downstream's `listTools`
 * and re-advertises every tool on the upstream server as a 1:1
 * proxy. Collision policy is first-wins with the native `nova.*`
 * tools seeded into the "taken" set.
 */

// Module-scoped downstream stash so SIGINT/SIGTERM shutdown can close
// them cleanly. Mounted onto the server before `server.connect(...)`
// so the initial handshake already reports the full proxied surface.
let downstreams: Downstream[] = [];

const NATIVE_TOOL_NAMES = [
  'nova.ops.overview',
  'nova.ops.healthcheck',
  'nova.ops.cost.snapshot',
  'nova.operator.plan',
  'nova.models.list',
];

async function main(): Promise<void> {
  const server = buildNovaMcpServer();

  let config: Awaited<ReturnType<typeof loadConfig>> = null;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`nova-mcp: facade config error — ${(err as Error).message}\n`);
  }
  downstreams = await bootAll(config);

  const proxyResult = await mountProxyTools(server, downstreams, NATIVE_TOOL_NAMES);
  registerUnifiedTools(server, downstreams);

  process.stderr.write(
    `nova-mcp: facade ready — ${downstreams.length} downstreams, ${proxyResult.mounted} proxied tools (${proxyResult.skipped.length} skipped), ${NATIVE_TOOL_NAMES.length} native tools.\n`,
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
