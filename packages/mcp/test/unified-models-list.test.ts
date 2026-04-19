import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  bootDownstreamWithTransport,
  type Downstream,
} from '../src/facade/downstream.js';
import type { DownstreamSpec } from '../src/facade/config.js';
import { registerUnifiedTools } from '../src/tools/unified.js';

/**
 * Phase-4 (option C) tests — nova.models.list only. Three fake
 * downstream servers ("llamactl", "sirius", "embersynth") are booted
 * over InMemoryTransport pairs and passed to registerUnifiedTools.
 * An in-proc client calls nova.models.list through the upstream and
 * we assert on merge / dedupe / partial-failure semantics.
 */

function specOf(name: string): DownstreamSpec {
  return { name, transport: 'stdio', command: 'unused-in-test', args: [] };
}

interface ToolStub {
  name: string;
  response?: unknown; // JSON serialized into the text block
  throws?: string;
  captured?: { last: Record<string, unknown> | null };
}

async function makeDownstream(
  name: string,
  tools: ToolStub[],
): Promise<Downstream> {
  const server = new McpServer({ name: `fake-${name}`, version: '0.0.0' });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: `fake ${t.name}`,
        inputSchema: {
          scope: z.string().optional(),
        },
      },
      async (input) => {
        if (t.captured) t.captured.last = input as Record<string, unknown>;
        if (t.throws) {
          throw new Error(t.throws);
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(t.response ?? null) },
          ],
        };
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

function parseResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const text = content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

interface ModelEntry {
  id: string;
  provenance: 'llamactl' | 'sirius' | 'embersynth';
  details: unknown;
  alsoAvailableIn?: string[];
}

describe('nova.models.list', () => {
  test('all three reachable — merges and dedupes by id with stable priority', async () => {
    // llamactl claims gpt-4o-mini (via `rel`), plus a local-only entry.
    const llamactl = await makeDownstream('llamactl', [
      {
        name: 'llamactl.catalog.list',
        response: [
          { id: 'gpt-4o-mini', rel: 'gpt-4o-mini', label: 'via-llamactl' },
          { id: 'qwen36-q4m', rel: 'Qwen3.6/q4m.gguf', label: 'qwen-local' },
        ],
      },
    ]);
    // sirius also advertises gpt-4o-mini (overlap — llamactl wins).
    const sirius = await makeDownstream('sirius', [
      {
        name: 'sirius.models.list',
        response: {
          status: 200,
          body: {
            object: 'list',
            data: [
              { id: 'gpt-4o-mini', owned_by: 'openai' },
              { id: 'claude-4.7-sonnet', owned_by: 'anthropic' },
            ],
          },
        },
      },
    ]);
    const embersynth = await makeDownstream('embersynth', [
      {
        name: 'embersynth.synthetic.list',
        response: {
          count: 1,
          syntheticModels: { 'fusion-auto': 'auto' },
        },
      },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    registerUnifiedTools(upstream, [llamactl, sirius, embersynth]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const raw = await client.callTool({ name: 'nova.models.list', arguments: {} });
      const body = parseResult(raw) as { models: ModelEntry[]; partial?: unknown };

      // No partial key when nothing failed.
      expect(body.partial).toBeUndefined();

      const byId = new Map(body.models.map((m) => [m.id, m]));
      // gpt-4o-mini appears once, claimed by llamactl first, with sirius appended.
      const shared = byId.get('gpt-4o-mini');
      expect(shared).toBeDefined();
      expect(shared?.provenance).toBe('llamactl');
      expect(shared?.alsoAvailableIn).toEqual(['sirius']);

      // llamactl-only entry survives with no alsoAvailableIn.
      const qwen = byId.get('Qwen3.6/q4m.gguf');
      expect(qwen?.provenance).toBe('llamactl');
      expect(qwen?.alsoAvailableIn).toBeUndefined();

      // sirius-only entry.
      const claude = byId.get('claude-4.7-sonnet');
      expect(claude?.provenance).toBe('sirius');

      // embersynth synthetic name.
      const fusion = byId.get('fusion-auto');
      expect(fusion?.provenance).toBe('embersynth');
    } finally {
      await close();
      await llamactl.close();
      await sirius.close();
      await embersynth.close();
    }
  });

  test('one downstream fails — partial reports the failure, others survive', async () => {
    const llamactl = await makeDownstream('llamactl', [
      {
        name: 'llamactl.catalog.list',
        response: [{ id: 'x', rel: 'x/y.gguf' }],
      },
    ]);
    const sirius = await makeDownstream('sirius', [
      { name: 'sirius.models.list', throws: 'sirius-boom' },
    ]);
    const embersynth = await makeDownstream('embersynth', [
      {
        name: 'embersynth.synthetic.list',
        response: { count: 1, syntheticModels: { 'fusion-auto': 'auto' } },
      },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    registerUnifiedTools(upstream, [llamactl, sirius, embersynth]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const raw = await client.callTool({ name: 'nova.models.list', arguments: {} });
      const body = parseResult(raw) as {
        models: ModelEntry[];
        partial?: { failed: string[]; errors: Record<string, string> };
      };

      const ids = body.models.map((m) => m.id).sort();
      expect(ids).toEqual(['fusion-auto', 'x/y.gguf']);

      expect(body.partial).toBeDefined();
      expect(body.partial?.failed).toEqual(['sirius']);
      expect(body.partial?.errors.sirius).toContain('sirius-boom');
    } finally {
      await close();
      await llamactl.close();
      await sirius.close();
      await embersynth.close();
    }
  });

  test('all three fail — empty models, all three in partial, no isError', async () => {
    const llamactl = await makeDownstream('llamactl', [
      { name: 'llamactl.catalog.list', throws: 'llamactl-down' },
    ]);
    const sirius = await makeDownstream('sirius', [
      { name: 'sirius.models.list', throws: 'sirius-down' },
    ]);
    const embersynth = await makeDownstream('embersynth', [
      { name: 'embersynth.synthetic.list', throws: 'embersynth-down' },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    registerUnifiedTools(upstream, [llamactl, sirius, embersynth]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const raw = await client.callTool({ name: 'nova.models.list', arguments: {} });
      const resShape = raw as { isError?: boolean };
      expect(resShape.isError).not.toBe(true);

      const body = parseResult(raw) as {
        models: ModelEntry[];
        partial?: { failed: string[]; errors: Record<string, string> };
      };
      expect(body.models).toEqual([]);
      expect(body.partial).toBeDefined();
      expect(body.partial?.failed.sort()).toEqual(['embersynth', 'llamactl', 'sirius']);
      expect(body.partial?.errors.llamactl).toContain('llamactl-down');
      expect(body.partial?.errors.sirius).toContain('sirius-down');
      expect(body.partial?.errors.embersynth).toContain('embersynth-down');
    } finally {
      await close();
      await llamactl.close();
      await sirius.close();
      await embersynth.close();
    }
  });

  test('absent from config — llamactl-only result, no partial key', async () => {
    const llamactl = await makeDownstream('llamactl', [
      {
        name: 'llamactl.catalog.list',
        response: [{ id: 'alpha', rel: 'alpha/a.gguf' }],
      },
    ]);
    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    registerUnifiedTools(upstream, [llamactl]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      const raw = await client.callTool({ name: 'nova.models.list', arguments: {} });
      const body = parseResult(raw) as { models: ModelEntry[]; partial?: unknown };
      expect(body.partial).toBeUndefined();
      expect(body.models).toHaveLength(1);
      expect(body.models[0]?.id).toBe('alpha/a.gguf');
      expect(body.models[0]?.provenance).toBe('llamactl');
    } finally {
      await close();
      await llamactl.close();
    }
  });

  test('scope forwards to llamactl only; others see no scope arg', async () => {
    const llamactlCaptured = { last: null as Record<string, unknown> | null };
    const siriusCaptured = { last: null as Record<string, unknown> | null };
    const embCaptured = { last: null as Record<string, unknown> | null };

    const llamactl = await makeDownstream('llamactl', [
      {
        name: 'llamactl.catalog.list',
        response: [],
        captured: llamactlCaptured,
      },
    ]);
    const sirius = await makeDownstream('sirius', [
      {
        name: 'sirius.models.list',
        response: { status: 200, body: { data: [] } },
        captured: siriusCaptured,
      },
    ]);
    const embersynth = await makeDownstream('embersynth', [
      {
        name: 'embersynth.synthetic.list',
        response: { count: 0, syntheticModels: {} },
        captured: embCaptured,
      },
    ]);

    const upstream = new McpServer({ name: 'up', version: '0.0.0' });
    registerUnifiedTools(upstream, [llamactl, sirius, embersynth]);

    const { client, close } = await connectedUpstream(upstream);
    try {
      await client.callTool({
        name: 'nova.models.list',
        arguments: { scope: 'custom' },
      });
      expect(llamactlCaptured.last?.scope).toBe('custom');
      // sirius + embersynth fake handlers use `scope: z.string().optional()`;
      // the nova tool sends no arg to them, so captured.scope is undefined.
      expect(siriusCaptured.last?.scope).toBeUndefined();
      expect(embCaptured.last?.scope).toBeUndefined();
    } finally {
      await close();
      await llamactl.close();
      await sirius.close();
      await embersynth.close();
    }
  });
});
