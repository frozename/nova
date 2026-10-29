import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import type { DownstreamSpec } from "../src/facade/config.js";

import { bootDownstreamWithTransport, type Downstream } from "../src/facade/downstream.js";
import { type MountProxyResult, mountProxyTools } from "../src/facade/proxy.js";

/**
 * Phase-3 proxy layer tests. Two or more fake "downstream" `McpServer`
 * instances are hung off `InMemoryTransport` pairs, wrapped in
 * `Downstream` via the facade's test seam, then mounted on a fresh
 * upstream server via `mountProxyTools`. An in-proc Client talks to
 * the upstream to prove the happy path + collision policy + error
 * surfacing.
 *
 * Shapes copied from `smoke.test.ts` and `facade-downstream.test.ts`.
 */

function specOf(name: string): DownstreamSpec {
  return { name, transport: "stdio", command: "unused-in-test", args: [] };
}

interface CapturedArgs {
  last: Record<string, unknown> | null;
}

async function makeDownstream(
  name: string,
  tools: {
    name: string;
    response: string;
    captured?: CapturedArgs;
  }[],
): Promise<Downstream> {
  const server = new McpServer({ name: `fake-${name}`, version: "0.0.0" });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: `fake ${t.name}`,
        inputSchema: { value: z.string().optional() },
      },
      (input) => {
        if (t.captured) t.captured.last = input;
        return { content: [{ type: "text" as const, text: t.response }] };
      },
    );
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return await bootDownstreamWithTransport(specOf(name), clientSide);
}

async function connectedUpstream(
  upstream: McpServer,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

// A downstream that registers only a resource never advertises the tools
// capability, so its tools/list answers -32601 Method not found.
async function makeToollessDownstream(name: string): Promise<Downstream> {
  const server = new McpServer({ name: `fake-${name}`, version: "0.0.0" });
  server.registerResource(
    "only-resource",
    "nova-test://only-resource",
    { mimeType: "text/plain" },
    (uri: URL): { contents: { text: string; uri: string }[] } => ({
      contents: [{ uri: uri.href, text: "resource-body" }],
    }),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return await bootDownstreamWithTransport(specOf(name), clientSide);
}

interface SettledMount {
  error: string | null;
  result: MountProxyResult | null;
}

// Turns a rejection into data so a test fails on expect(error).toBeNull()
// instead of on an uncaught throw.
async function mountSettled(upstream: McpServer, downstreams: Downstream[]): Promise<SettledMount> {
  try {
    const result = await mountProxyTools(upstream, downstreams);
    return { error: null, result };
  } catch (err) {
    return { error: String(err), result: null };
  }
}

interface ToolPage {
  nextCursor?: string;
  tools: Tool[];
}

function pagedTool(name: string): Tool {
  return { name, description: `paged ${name}`, inputSchema: { type: "object" } };
}

// Replaces d.client.listTools with a stub that answers each tools/list request
// with serve(cursor), where cursor is params.cursor, or "" when the request has
// none. An Error answer becomes a rejection. Every cursor asked for is pushed
// onto seenCursors, in order.
function stubToolPages(
  d: Downstream,
  serve: (cursor: string) => Error | ToolPage,
  seenCursors: string[],
): void {
  (d.client as unknown as { listTools: unknown }).listTools = (params?: {
    cursor?: string;
  }): Promise<ToolPage> => {
    const cursor = params?.cursor ?? "";
    seenCursors.push(cursor);
    const answer = serve(cursor);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

// stderr spy ------------------------------------------------------------
let stderrWrites: string[] = [];
let originalStderrWrite: typeof process.stderr.write | null = null;

beforeEach(() => {
  stderrWrites = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => {
    stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
});
afterEach(() => {
  if (originalStderrWrite) process.stderr.write = originalStderrWrite;
});

describe("facade/proxy mountProxyTools", () => {
  test("happy path: advertises the union of downstream tools", async () => {
    const d1 = await makeDownstream("d1", [
      { name: "llamactl.one", response: "r1" },
      { name: "llamactl.two", response: "r2" },
    ]);
    const d2 = await makeDownstream("d2", [
      { name: "sirius.one", response: "s1" },
      { name: "sirius.two", response: "s2" },
    ]);
    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const result = await mountProxyTools(upstream, [d1, d2]);
    expect(result.mounted).toBe(4);
    expect(result.skipped).toEqual([]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(["llamactl.one", "llamactl.two", "sirius.one", "sirius.two"]);
    } finally {
      await close();
      await d1.close();
      await d2.close();
    }
  });

  test("forwards args and response verbatim", async () => {
    const captured: CapturedArgs = { last: null };
    const d1 = await makeDownstream("d1", [
      { name: "llamactl.echo", response: "canned-response", captured },
    ]);
    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    await mountProxyTools(upstream, [d1]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({
        name: "llamactl.echo",
        arguments: { value: "hello", extra: 42 },
      });
      expect(textOf(res)).toBe("canned-response");
      // The downstream's handler received the same args (value
      // preserved; extras may be stripped by the fake downstream's
      // own Zod schema, but at the very least `value` should arrive).
      expect(captured.last?.["value"]).toBe("hello");
    } finally {
      await close();
      await d1.close();
    }
  });

  test("collision: second downstream is skipped with stderr warning", async () => {
    const d1 = await makeDownstream("d1", [{ name: "shared.tool", response: "from-d1" }]);
    const d2 = await makeDownstream("d2", [{ name: "shared.tool", response: "from-d2" }]);
    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const result = await mountProxyTools(upstream, [d1, d2]);

    expect(result.mounted).toBe(1);
    expect(result.skipped).toEqual([{ name: "shared.tool", from: "d2", reason: "collision" }]);
    expect(
      stderrWrites.some(
        (line) =>
          line.includes("shared.tool") && line.includes('"d2"') && line.includes("collision"),
      ),
    ).toBe(true);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({
        name: "shared.tool",
        arguments: {},
      });
      expect(textOf(res)).toBe("from-d1");
    } finally {
      await close();
      await d1.close();
      await d2.close();
    }
  });

  test("native tool collision: upstream keeps its own, downstream skipped", async () => {
    const d1 = await makeDownstream("d1", [{ name: "foo.bar", response: "from-d1" }]);
    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    upstream.registerTool(
      "foo.bar",
      {
        description: "native",
        inputSchema: {},
      },
      () => ({ content: [{ type: "text" as const, text: "native-response" }] }),
    );

    const result = await mountProxyTools(upstream, [d1], ["foo.bar"]);
    expect(result.mounted).toBe(0);
    expect(result.skipped).toEqual([{ name: "foo.bar", from: "d1", reason: "collision" }]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({ name: "foo.bar", arguments: {} });
      expect(textOf(res)).toBe("native-response");
    } finally {
      await close();
      await d1.close();
    }
  });

  test("downstream rejection surfaces as MCP error (isError + message)", async () => {
    const d1 = await makeDownstream("d1", [{ name: "boom.tool", response: "unused" }]);
    // Replace the downstream client's callTool with a rejecting stub.
    const originalCallTool = d1.client.callTool.bind(d1.client);
    (d1.client as unknown as { callTool: unknown }).callTool = (): Promise<never> =>
      Promise.reject(new Error("boom"));

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    await mountProxyTools(upstream, [d1]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({ name: "boom.tool", arguments: {} });
      const err = res as { isError?: boolean; content?: { text?: string }[] };
      expect(err.isError).toBe(true);
      expect(err.content?.[0]?.text ?? "").toContain("boom");
    } finally {
      await close();
      // Restore so close() doesn't explode.
      (d1.client as unknown as { callTool: unknown }).callTool = originalCallTool;
      await d1.close();
    }
  });

  test("listTools rejection: that downstream is skipped and later ones still mount", async () => {
    const a = await makeDownstream("a", [{ name: "a.ping", response: "pong" }]);
    const b = await makeDownstream("b", [{ name: "b.ping", response: "unused" }]);
    (b.client as unknown as { listTools: unknown }).listTools = (): Promise<never> =>
      Promise.reject(new Error("list boom"));

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    // The failing downstream comes first, so a break or return would leave "a" unmounted.
    const { error, result } = await mountSettled(upstream, [b, a]);

    expect(error).toBeNull();
    expect(result?.mounted).toBe(1);
    expect(result?.skipped).toEqual([{ name: "*", from: "b", reason: "list-failed" }]);
    expect(
      stderrWrites.some(
        (line) => line.includes('listTools failed for "b"') && line.includes("list boom"),
      ),
    ).toBe(true);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(["a.ping"]);
    } finally {
      await close();
      await a.close();
      await b.close();
    }
  });

  test("downstream without the tools capability is skipped, the others still mount", async () => {
    const a = await makeDownstream("a", [{ name: "a.ping", response: "pong" }]);
    const b = await makeToollessDownstream("b");

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [a, b]);

    expect(error).toBeNull();
    expect(result?.mounted).toBe(1);
    expect(result?.skipped).toEqual([{ name: "*", from: "b", reason: "list-failed" }]);
    expect(stderrWrites.some((line) => line.includes('listTools failed for "b"'))).toBe(true);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(["a.ping"]);
    } finally {
      await close();
      await a.close();
      await b.close();
    }
  });
});

describe("facade/proxy mountProxyTools: paginated tools/list", () => {
  test("paginated tools/list: tools on every page are mounted", async () => {
    const d = await makeDownstream("paged", [
      { name: "paged.one", response: "r1" },
      { name: "paged.two", response: "r2" },
    ]);
    const seenCursors: string[] = [];
    stubToolPages(
      d,
      (cursor: string): ToolPage =>
        cursor === ""
          ? { tools: [pagedTool("paged.one")], nextCursor: "p2" }
          : { tools: [pagedTool("paged.two")] },
      seenCursors,
    );

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [d]);

    expect(error).toBeNull();
    expect(result?.mounted).toBe(2);
    expect(result?.skipped).toEqual([]);
    expect(seenCursors).toEqual(["", "p2"]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name).sort()).toEqual(["paged.one", "paged.two"]);
      const res = await client.callTool({ name: "paged.two", arguments: {} });
      expect(textOf(res)).toBe("r2");
    } finally {
      await close();
      await d.close();
    }
  });

  test("a repeated cursor stops the walk and keeps the tools collected so far", async () => {
    const d = await makeDownstream("loopy", [
      { name: "loopy.one", response: "l1" },
      { name: "loopy.two", response: "l2" },
    ]);
    const seenCursors: string[] = [];
    stubToolPages(
      d,
      (cursor: string): ToolPage => ({
        tools: [pagedTool(cursor === "" ? "loopy.one" : "loopy.two")],
        nextCursor: "loop",
      }),
      seenCursors,
    );

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [d]);

    try {
      expect(error).toBeNull();
      expect(result?.mounted).toBe(2);
      expect(result?.skipped).toEqual([]);
      expect(seenCursors).toEqual(["", "loop"]);
      expect(
        stderrWrites.some((line) => line.includes('"loopy"') && line.includes("repeated cursor")),
      ).toBe(true);
    } finally {
      await d.close();
    }
  });

  test("the page cap stops a cursor that never repeats", async () => {
    const d = await makeDownstream("capped", [{ name: "capped.one", response: "c1" }]);
    const seenCursors: string[] = [];
    stubToolPages(
      d,
      (cursor: string): ToolPage =>
        cursor === ""
          ? { tools: [pagedTool("capped.one")], nextCursor: "c1" }
          : { tools: [], nextCursor: `${cursor}+` },
      seenCursors,
    );

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [d]);

    try {
      expect(error).toBeNull();
      expect(result?.mounted).toBe(1);
      // 100 is MAX_TOOL_LIST_PAGES in src/facade/proxy.ts.
      expect(seenCursors).toHaveLength(100);
      expect(result?.skipped).toEqual([]);
      expect(
        stderrWrites.some(
          (line) => line.includes('"capped"') && line.includes("exceeded 100 pages"),
        ),
      ).toBe(true);
    } finally {
      await d.close();
    }
  });

  test("an empty nextCursor ends the walk after one request", async () => {
    const d = await makeDownstream("flat", [{ name: "flat.one", response: "f1" }]);
    const seenCursors: string[] = [];
    stubToolPages(
      d,
      (): ToolPage => ({ tools: [pagedTool("flat.one")], nextCursor: "" }),
      seenCursors,
    );

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [d]);

    try {
      expect(error).toBeNull();
      expect(result?.mounted).toBe(1);
      expect(seenCursors).toEqual([""]);
      expect(stderrWrites.some((line) => line.includes("tools/list for"))).toBe(false);
    } finally {
      await d.close();
    }
  });

  test("a rejection on a later page skips that downstream as list-failed", async () => {
    const d = await makeDownstream("pagefail", [{ name: "pagefail.one", response: "unused" }]);
    const seenCursors: string[] = [];
    stubToolPages(
      d,
      (cursor: string): Error | ToolPage =>
        cursor === ""
          ? { tools: [pagedTool("pagefail.one")], nextCursor: "p2" }
          : new Error("page boom"),
      seenCursors,
    );

    const upstream = new McpServer({ name: "up", version: "0.0.0" });
    const { error, result } = await mountSettled(upstream, [d]);

    try {
      expect(error).toBeNull();
      expect(result?.mounted).toBe(0);
      expect(result?.skipped).toEqual([{ name: "*", from: "pagefail", reason: "list-failed" }]);
      expect(seenCursors).toEqual(["", "p2"]);
      expect(
        stderrWrites.some(
          (line) => line.includes('listTools failed for "pagefail"') && line.includes("page boom"),
        ),
      ).toBe(true);
    } finally {
      await d.close();
    }
  });
});
