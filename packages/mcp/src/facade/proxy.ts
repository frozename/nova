// Proxy layer for the nova-mcp facade. For each connected downstream
// we snapshot its tool surface via `client.listTools()` and
// re-advertise every tool on the upstream `McpServer` 1:1, forwarding
// the call through the downstream `Client` verbatim. Namespaces are
// preserved (no renaming); the first downstream to claim a name wins
// and subsequent collisions are logged + skipped.
//
// SDK signature reference:
//   node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:150
//     registerTool<..., InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
//       name: string,
//       config: { title?; description?; inputSchema?: InputArgs; ... },
//       cb: ToolCallback<InputArgs>,
//     ): RegisteredTool
//   zod-compat.d.ts:3-5 defines ZodRawShapeCompat = Record<string, AnySchema>
//   and AnySchema = z3.ZodTypeAny | z4.$ZodType — plain JSON-schema
//   objects are NOT accepted. Downstream `tool.inputSchema` is a
//   JSON-schema shape (types.d.ts:2381-2419), so we wrap args in a
//   `z.looseObject({})` pass-through schema — this preserves every
//   field through validation (default v4 `z.object` strips extras).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import type { Downstream } from "./downstream.js";

export interface ProxySkip {
  /** The skipped tool's name, or "*" when the downstream's tools/list itself failed. */
  name: string;
  from: string;
  reason: "collision" | "schema-invalid" | "list-failed";
}

export interface MountProxyResult {
  mounted: number;
  skipped: ProxySkip[];
}

// tools/list can reject after a successful connect: a downstream without the
// tools capability answers -32601, the request can time out, or the child can
// exit. Log it and return null so the caller skips this downstream only.
async function listDownstreamTools(
  downstreamName: string,
  client: Downstream["client"],
): Promise<Tool[] | null> {
  try {
    const { tools } = await client.listTools();
    return tools;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`nova-mcp: proxy: listTools failed for "${downstreamName}": ${msg}\n`);
    return null;
  }
}

/**
 * Mount every downstream's tools on the upstream server as 1:1
 * proxies. Returns a summary of how many were mounted and which were
 * skipped (and why). First-wins collision policy — callers seed the
 * `nativeNames` set with any tool names already registered on
 * `server` so the proxy doesn't clobber native `nova.*` tools.
 */
export async function mountProxyTools(
  server: McpServer,
  downstreams: Downstream[],
  nativeNames: Iterable<string> = [],
): Promise<MountProxyResult> {
  const taken = new Set<string>(nativeNames);
  const skipped: ProxySkip[] = [];
  let mounted = 0;

  for (const { name: downstreamName, client } of downstreams) {
    const tools = await listDownstreamTools(downstreamName, client);
    if (tools === null) {
      skipped.push({ name: "*", from: downstreamName, reason: "list-failed" });
      continue;
    }
    for (const tool of tools) {
      if (taken.has(tool.name)) {
        skipped.push({ name: tool.name, from: downstreamName, reason: "collision" });
        process.stderr.write(
          `nova-mcp: proxy: skipping "${tool.name}" from "${downstreamName}" (collision — first-wins)\n`,
        );
        continue;
      }
      server.registerTool(
        tool.name,
        {
          description: tool.description ?? "",
          // Pass-through schema — see file header for why looseObject.
          inputSchema: z.looseObject({}),
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
          try {
            const res = await client.callTool({
              name: tool.name,
              arguments: args,
            });
            // `client.callTool` widens to CallToolResult |
            // CompatibilityCallToolResult; downstream nova-family
            // servers always emit the modern shape, so cast through
            // unknown to satisfy the server-side CallToolResult
            // expected by `registerTool`'s callback.
            return res as unknown as CallToolResult;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text", text: `downstream error: ${msg}` }],
              isError: true,
            };
          }
        },
      );
      taken.add(tool.name);
      mounted++;
    }
  }

  return { mounted, skipped };
}
