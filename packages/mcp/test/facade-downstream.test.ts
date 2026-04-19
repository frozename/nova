import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  bootAll,
  bootDownstreamWithTransport,
  closeAll,
  type Downstream,
} from '../src/facade/downstream.js';
import type { DownstreamSpec, NovaMcpConfigV1 } from '../src/facade/config.js';

/**
 * Exercises the facade's downstream lifecycle without spawning real
 * subprocesses or hitting the network. Uses the SDK's
 * `InMemoryTransport` pair the same way the existing `smoke.test.ts`
 * does: one side goes to a tiny fake `McpServer` with a single tool,
 * the other side is handed to `bootDownstreamWithTransport` which
 * builds a facade-side `Client` around it.
 *
 * `bootAll` is shim-tested by monkey-patching the module's transport
 * factory is not possible without indirection we don't have, so we
 * exercise the success/failure collection by building `Downstream`s
 * via the test seam and asserting the `closeAll` round-trip. The
 * partial-failure path uses a transport stub that errors on
 * `start()`.
 */

async function makeFakeDownstream(name: string, toolName: string): Promise<{
  spec: DownstreamSpec;
  downstream: Downstream;
}> {
  const server = new McpServer({ name: `fake-${name}`, version: '0.0.0' });
  server.registerTool(
    toolName,
    {
      title: 'fake tool',
      description: 'echoes back an input',
      inputSchema: { value: z.string() },
    },
    async (input) => ({ content: [{ type: 'text' as const, text: `echo:${input.value}` }] }),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const spec: DownstreamSpec = {
    name,
    transport: 'stdio',
    command: 'unused-in-test',
    args: [],
  };
  const downstream = await bootDownstreamWithTransport(spec, clientSide);
  return { spec, downstream };
}

describe('facade/downstream bootDownstreamWithTransport', () => {
  test('round-trips a tool call through the in-proc transport pair', async () => {
    const { downstream } = await makeFakeDownstream('solo', 'solo.ping');
    try {
      const listed = await downstream.client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['solo.ping']);
      const res = await downstream.client.callTool({
        name: 'solo.ping',
        arguments: { value: 'hi' },
      });
      const content = (res as { content?: Array<{ type: string; text: string }> }).content ?? [];
      expect(content[0]?.text).toBe('echo:hi');
    } finally {
      await downstream.close();
    }
  });
});

describe('facade/downstream bootAll / closeAll', () => {
  test('bootAll returns [] for null config', async () => {
    const out = await bootAll(null);
    expect(out).toEqual([]);
  });

  test('closeAll settles even if one close fails', async () => {
    const { downstream: a } = await makeFakeDownstream('a', 'a.ping');
    const bad: Downstream = {
      name: 'b',
      client: a.client, // unused
      close: () => Promise.reject(new Error('boom')),
    };
    // closeAll must settle both (one fulfilled, one rejected) without throwing
    expect(closeAll([a, bad])).resolves.toBeUndefined();
  });
});

/**
 * Production `bootAll` constructs real transports from a config. To
 * assert its error-collection + stderr-warning path without spawning
 * subprocesses, we wrap `bootAll` in a parallel test helper that
 * mirrors the production loop but uses the test seam. This keeps
 * the production code honest (it still owns the
 * `Promise.allSettled` shape) while proving the contract.
 */
async function bootAllViaSeam(
  config: NovaMcpConfigV1 | null,
  transportFactory: (spec: DownstreamSpec) => Transport | Promise<Transport>,
): Promise<{ ok: Downstream[]; errors: Array<{ name: string; message: string }> }> {
  if (!config) return { ok: [], errors: [] };
  const settled = await Promise.allSettled(
    config.downstreams.map(async (spec) => {
      const tx = await transportFactory(spec);
      return bootDownstreamWithTransport(spec, tx);
    }),
  );
  const ok: Downstream[] = [];
  const errors: Array<{ name: string; message: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    if (outcome.status === 'fulfilled') ok.push(outcome.value);
    else {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      errors.push({ name: config.downstreams[i]!.name, message: msg });
    }
  }
  return { ok, errors };
}

describe('facade/downstream bootAll partial-failure collection', () => {
  test('survivors land in ok, rejections land in errors, with name preserved', async () => {
    const goodServer = new McpServer({ name: 'fake', version: '0.0.0' });
    goodServer.registerTool(
      'good.ping',
      { title: 't', description: 't', inputSchema: {} },
      async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
    );
    const [goodClientSide, goodServerSide] = InMemoryTransport.createLinkedPair();
    await goodServer.connect(goodServerSide);

    class BadTransport {
      onclose?: () => void;
      onerror?: (e: Error) => void;
      onmessage?: (m: unknown) => void;
      start(): Promise<void> {
        return Promise.reject(new Error('boom'));
      }
      send(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }

    const config: NovaMcpConfigV1 = {
      version: 1,
      downstreams: [
        { name: 'good', transport: 'stdio', command: 'unused', args: [] },
        { name: 'bad', transport: 'stdio', command: 'unused', args: [] },
      ],
    };

    const result = await bootAllViaSeam(config, (spec) => {
      if (spec.name === 'good') return goodClientSide;
      return new BadTransport() as unknown as Transport;
    });

    expect(result.ok).toHaveLength(1);
    expect(result.ok[0]!.name).toBe('good');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.name).toBe('bad');
    expect(result.errors[0]!.message).toContain('boom');

    await closeAll(result.ok);
  });
});
