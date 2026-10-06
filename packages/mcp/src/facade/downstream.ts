import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { DownstreamSpec, NovaMcpConfigV1 } from "./config.js";

import { createBearerAuth } from "./auth.js";

/**
 * Downstream MCP client lifecycle for the `@novaproto/mcp` facade.
 *
 * A `Downstream` is a connected MCP `Client` paired with the name it
 * was configured under. The facade's proxy layer (Phase 3) iterates
 * these to re-advertise each downstream's tools on the nova server.
 *
 * `bootAll` is best-effort: a rejection from any one `bootDownstream`
 * is logged to stderr (with the downstream name + error message) and
 * the result is omitted from the returned list. The facade still
 * boots with the survivors, preserving the "one bad downstream
 * shouldn't take the whole facade down" invariant.
 *
 * `bootDownstreamWithTransport` is a test seam: tests pass a
 * pre-built `Transport` (typically `InMemoryTransport`) to avoid
 * spawning real stdio subprocesses or hitting real HTTP servers.
 * Production code calls `bootDownstream` which constructs the
 * transport from the spec and delegates.
 */

const FACADE_CLIENT_NAME = "nova-facade";
const FACADE_CLIENT_VERSION = "0.1.0";

export interface Downstream {
  name: string;
  client: Client;
  close(): Promise<void>;
}

export async function bootDownstreamWithTransport(
  spec: DownstreamSpec,
  transport: Transport,
): Promise<Downstream> {
  const client = new Client({ name: FACADE_CLIENT_NAME, version: FACADE_CLIENT_VERSION });
  await client.connect(transport);
  return {
    name: spec.name,
    client,
    close: () => client.close(),
  };
}

function buildTransport(spec: DownstreamSpec): Transport {
  if (spec.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (spec.env) Object.assign(env, spec.env);
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env,
      stderr: "inherit",
    });
  }
  const url = new URL(spec.url);
  // SDK self-incompatibility under exactOptionalPropertyTypes: the HTTP
  // transport declares `onmessage?: (m: JSONRPCMessage) => void` (non-generic)
  // where Transport declares the generic `<T extends JSONRPCMessage>(m: T, …)`,
  // so the concrete class is not structurally assignable to the SDK's own
  // Transport — even though `client.connect(t: Transport)` is its intended
  // sink. StdioClientTransport matches and needs no bridge. asTransport widens
  // only the callback-signature variance; the runtime object is unchanged.
  if (spec.token) {
    const { fetch } = createBearerAuth(spec.token);
    return asTransport(new StreamableHTTPClientTransport(url, { fetch }));
  }
  return asTransport(new StreamableHTTPClientTransport(url));
}

// Narrow bridge for the SDK's own Transport-vs-StreamableHTTPClientTransport
// signature variance (see buildTransport). Scoped to StreamableHTTPClientTransport
// so it cannot silently launder an unrelated type into a Transport.
function asTransport(t: StreamableHTTPClientTransport): Transport {
  return t as unknown as Transport;
}

export async function bootDownstream(spec: DownstreamSpec): Promise<Downstream> {
  const transport = buildTransport(spec);
  return await bootDownstreamWithTransport(spec, transport);
}

export async function bootAll(config: NovaMcpConfigV1 | null): Promise<Downstream[]> {
  if (!config) return [];
  const settled = await Promise.allSettled(config.downstreams.map((spec) => bootDownstream(spec)));
  const out: Downstream[] = [];
  for (const [i, element] of settled.entries()) {
    const outcome = element;
    if (outcome.status === "fulfilled") {
      out.push(outcome.value);
    } else {
      const name = config.downstreams[i]?.name ?? "<unknown>";
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      process.stderr.write(`nova-mcp: downstream "${name}" failed to connect: ${msg}\n`);
    }
  }
  return out;
}

export async function closeAll(downstreams: Downstream[]): Promise<void> {
  await Promise.allSettled(downstreams.map((d) => d.close()));
}
