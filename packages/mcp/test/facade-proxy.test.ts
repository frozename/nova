import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  bootDownstreamWithTransport,
  type Downstream,
} from '../src/facade/downstream.js';
import type { DownstreamSpec } from '../src/facade/config.js';
import { mountProxyTools } from '../src/facade/proxy.js';

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
  return { name, transport: 'stdio', command: 'unused-in-test', args: [] };
}

interface CapturedArgs {
  last: Record<string, unknown> | null;
}

async function makeDownstream(
  name: string,
  tools: Array<{
    name: string;
    response: string;
    captured?: CapturedArgs;
  }>,
): Promise<Downstream> {
  const server = new McpServer({ name: `fake-${name}`, version: '0.0.0' });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: `fake ${t.name}`,
        inputSchema: { value: z.string().optional() },
      },
      async (input) => {
        if (t.captured) t.captured.last = input as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: t.response }] };
      },
    );
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return bootDownstreamWithTransport(specOf(name), clientSide);
}

async function connectedUpstream(
  upstream: McpServer,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

// stderr spy ------------------------------------------------------------
let stderrWrites: string[] = [];
let originalStderrWrite: typeof process.stderr.write | null = null;

beforeEach(() => {
  stderrWrites = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  if (originalStderrWrite) process.stderr.write = originalStderrWrite;
});

describe('facade/proxy mountProxyTools', () => {
  test('happy path: advertises the union of downstream tools', async () => {
    const d1 = await makeDownstream('d1', [
      { name: 'llamactl.one', response: 'r1' },
      { name: 'llamactl.two', response: 'r2' },
    ]);
    const d2 = await makeDownstream('d2', [
      { name: 'sirius.one', response: 's1' },
      { name: 'sirius.two', response: 's2' },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    const result = await mountProxyTools(upstream, [d1, d2]);
    expect(result.mounted).toBe(4);
    expect(result.skipped).toEqual([]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'llamactl.one',
        'llamactl.two',
        'sirius.one',
        'sirius.two',
      ]);
    } finally {
      await close();
      await d1.close();
      await d2.close();
    }
  });

  test('forwards args and response verbatim', async () => {
    const captured: CapturedArgs = { last: null };
    const d1 = await makeDownstream('d1', [
      { name: 'llamactl.echo', response: 'canned-response', captured },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    await mountProxyTools(upstream, [d1]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({
        name: 'llamactl.echo',
        arguments: { value: 'hello', extra: 42 },
      });
      expect(textOf(res)).toBe('canned-response');
      // The downstream's handler received the same args (value
      // preserved; extras may be stripped by the fake downstream's
      // own Zod schema, but at the very least `value` should arrive).
      expect(captured.last?.value).toBe('hello');
    } finally {
      await close();
      await d1.close();
    }
  });

  test('collision: second downstream is skipped with stderr warning', async () => {
    const d1 = await makeDownstream('d1', [
      { name: 'shared.tool', response: 'from-d1' },
    ]);
    const d2 = await makeDownstream('d2', [
      { name: 'shared.tool', response: 'from-d2' },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    const result = await mountProxyTools(upstream, [d1, d2]);

    expect(result.mounted).toBe(1);
    expect(result.skipped).toEqual([
      { name: 'shared.tool', from: 'd2', reason: 'collision' },
    ]);
    expect(
      stderrWrites.some(
        (line) =>
          line.includes('shared.tool') &&
          line.includes('"d2"') &&
          line.includes('collision'),
      ),
    ).toBe(true);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({
        name: 'shared.tool',
        arguments: {},
      });
      expect(textOf(res)).toBe('from-d1');
    } finally {
      await close();
      await d1.close();
      await d2.close();
    }
  });

  test('native tool collision: upstream keeps its own, downstream skipped', async () => {
    const d1 = await makeDownstream('d1', [
      { name: 'foo.bar', response: 'from-d1' },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    upstream.registerTool(
      'foo.bar',
      {
        description: 'native',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text' as const, text: 'native-response' }] }),
    );

    const result = await mountProxyTools(upstream, [d1], ['foo.bar']);
    expect(result.mounted).toBe(0);
    expect(result.skipped).toEqual([
      { name: 'foo.bar', from: 'd1', reason: 'collision' },
    ]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({ name: 'foo.bar', arguments: {} });
      expect(textOf(res)).toBe('native-response');
    } finally {
      await close();
      await d1.close();
    }
  });

  test('downstream rejection surfaces as MCP error (isError + message)', async () => {
    const d1 = await makeDownstream('d1', [
      { name: 'boom.tool', response: 'unused' },
    ]);
    // Replace the downstream client's callTool with a rejecting stub.
    const originalCallTool = d1.client.callTool.bind(d1.client);
    (d1.client as unknown as { callTool: unknown }).callTool = () =>
      Promise.reject(new Error('boom'));

    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    await mountProxyTools(upstream, [d1]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const res = await client.callTool({ name: 'boom.tool', arguments: {} });
      const err = res as { isError?: boolean; content?: Array<{ text?: string }> };
      expect(err.isError).toBe(true);
      expect(err.content?.[0]?.text ?? '').toContain('boom');
    } finally {
      await close();
      // Restore so close() doesn't explode.
      (d1.client as unknown as { callTool: unknown }).callTool = originalCallTool;
      await d1.close();
    }
  });
});
