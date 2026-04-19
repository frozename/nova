import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createOpenAICompatProvider } from '../src/providers/openai-compat.js';

/**
 * E2E test for the OpenAI-compatible adapter. Stands up a stub
 * upstream that mimics the shapes OpenAI / Together / groq return,
 * then drives the adapter's full `AiProvider` surface through it.
 * Catches regressions in request shaping, SSE parsing, and error
 * translation without needing real cloud credentials.
 */

const UPSTREAM_PORT = 29021;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json({
          data: [
            { id: 'gpt-4o-mini', created: 1700000000, owned_by: 'openai' },
            { id: 'gpt-4o', created: 1700000000, owned_by: 'openai' },
          ],
        });
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = (await req.json()) as {
          stream?: boolean;
          model: string;
          tools?: unknown[];
          stream_options?: { include_usage?: boolean };
        };
        if (body.stream) {
          const toolCallRun = Array.isArray(body.tools) && body.tools.length > 0;
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              if (toolCallRun) {
                // Emit two partial tool_call deltas + a finish frame.
                controller.enqueue(
                  enc.encode(
                    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                      body.model +
                      '","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\""}}]}}]}\n\n',
                  ),
                );
                controller.enqueue(
                  enc.encode(
                    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                      body.model +
                      '","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
                  ),
                );
              } else {
                controller.enqueue(
                  enc.encode(
                    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                      body.model +
                      '","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n',
                  ),
                );
                controller.enqueue(
                  enc.encode(
                    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                      body.model +
                      '","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
                  ),
                );
              }
              if (body.stream_options?.include_usage) {
                controller.enqueue(
                  enc.encode(
                    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                      body.model +
                      '","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
                  ),
                );
              }
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return Response.json({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          model: body.model,
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        return new Response('ok', { status: 200 });
      }
      if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
        const body = (await req.json()) as { model: string; input: string };
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: body.model,
          usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => {
  upstream?.stop(true);
});

function makeProvider(): ReturnType<typeof createOpenAICompatProvider> {
  return createOpenAICompatProvider({
    name: 'stub',
    displayName: 'Stub',
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    apiKey: 'sk-test',
  });
}

describe('openai-compat provider', () => {
  test('listModels round-trips canonical ModelInfo', async () => {
    const p = makeProvider();
    const models = await p.listModels?.();
    expect(models).toHaveLength(2);
    expect(models?.[0]?.id).toBe('gpt-4o-mini');
    expect(models?.[0]?.object).toBe('model');
    expect(models?.[0]?.capabilities).toContain('chat');
  });

  test('createResponse includes latency + provider annotation', async () => {
    const p = makeProvider();
    const res = await p.createResponse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.choices[0]!.message.content).toBe('hello');
    expect(res.provider).toBe('stub');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.usage?.total_tokens).toBe(3);
  });

  test('streamResponse yields chunks then a done event', async () => {
    const p = makeProvider();
    const events: unknown[] = [];
    for await (const ev of p.streamResponse?.({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }) ?? []) {
      events.push(ev);
    }
    const chunks = events.filter(
      (e): e is { type: 'chunk'; chunk: { choices: [{ delta: { content?: string } }] } } =>
        (e as { type?: string }).type === 'chunk',
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const joined = chunks
      .map((c) => c.chunk.choices[0]?.delta.content ?? '')
      .join('');
    expect(joined).toBe('hello');
    const lastEvent = events[events.length - 1] as { type: string };
    expect(lastEvent.type).toBe('done');
  });

  test('createEmbeddings passes input + annotates provider', async () => {
    const p = makeProvider();
    const res = await p.createEmbeddings?.({
      model: 'text-embedding-3-small',
      input: 'abc',
    });
    expect(res?.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res?.provider).toBe('stub');
  });

  test('healthCheck reports healthy against a live upstream', async () => {
    const p = makeProvider();
    const h = await p.healthCheck?.();
    expect(h?.state).toBe('healthy');
    expect(h?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('healthCheck reports unhealthy when upstream is down', async () => {
    const bad = createOpenAICompatProvider({
      name: 'dead',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'x',
    });
    const h = await bad.healthCheck?.();
    expect(h?.state).toBe('unhealthy');
    expect(h?.error).toBeTruthy();
  });

  test('healthCheck honors healthPath for self-hosted /health endpoints', async () => {
    const p = createOpenAICompatProvider({
      name: 'local',
      // Root baseUrl — /health sits outside /v1 on self-hosted gateways.
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
      apiKey: 'x',
      healthPath: '/health',
    });
    const h = await p.healthCheck?.();
    expect(h?.state).toBe('healthy');
  });

  test('streamResponse preserves tool_call deltas', async () => {
    const p = makeProvider();
    const events: unknown[] = [];
    for await (const ev of p.streamResponse?.({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'call the search tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'search', description: 'search the web', parameters: {} },
        },
      ],
    }) ?? []) {
      events.push(ev);
    }
    const chunks = events.filter(
      (e): e is {
        type: 'chunk';
        chunk: {
          choices: Array<{
            delta: {
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
      } => (e as { type?: string }).type === 'chunk',
    );
    // Every chunk with tool_calls preserves the `index` field.
    const allToolCallFrames = chunks.flatMap(
      (c) => c.chunk.choices[0]?.delta.tool_calls ?? [],
    );
    expect(allToolCallFrames.length).toBeGreaterThanOrEqual(2);
    // First frame carries the id + name, subsequent frames carry arguments.
    expect(allToolCallFrames[0]?.id).toBe('call_1');
    expect(allToolCallFrames[0]?.function?.name).toBe('search');
    const joinedArgs = allToolCallFrames
      .map((f) => f.function?.arguments ?? '')
      .join('');
    expect(joinedArgs).toContain('hi');
    const lastEvent = events[events.length - 1] as { type: string; finish_reason?: string };
    expect(lastEvent.type).toBe('done');
    expect(lastEvent.finish_reason).toBe('tool_calls');
  });
});

describe('openai-compat provider — onUsage callback', () => {
  test('fires on non-streaming chat with provider + model + token counts', async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const p = createOpenAICompatProvider({
      name: 'stub',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'sk-test',
      onUsage: (s) => { snapshots.push({ ...s }); },
    });
    await p.createResponse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.provider).toBe('stub');
    expect(snapshots[0]!.model).toBe('gpt-4o-mini');
    expect(snapshots[0]!.kind).toBe('chat');
    expect(snapshots[0]!.prompt_tokens).toBe(2);
    expect(snapshots[0]!.completion_tokens).toBe(1);
    expect(snapshots[0]!.total_tokens).toBe(3);
    expect(typeof snapshots[0]!.latency_ms).toBe('number');
  });

  test('does not fire when the provider omits `usage`', async () => {
    const noUsagePort = UPSTREAM_PORT + 1;
    const server = Bun.serve({
      port: noUsagePort,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/chat/completions') {
          const body = (await req.json()) as { model: string };
          return Response.json({
            id: 'x',
            object: 'chat.completion',
            model: body.model,
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            // usage deliberately omitted
          });
        }
        return new Response('', { status: 404 });
      },
    });
    try {
      const snapshots: Array<Record<string, unknown>> = [];
      const p = createOpenAICompatProvider({
        name: 'no-usage',
        baseUrl: `http://127.0.0.1:${noUsagePort}/v1`,
        apiKey: 'sk',
        onUsage: (s) => { snapshots.push({ ...s }); },
      });
      await p.createResponse({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(snapshots).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test('onUsage throw does not bleed into the response path', async () => {
    const p = createOpenAICompatProvider({
      name: 'stub',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'sk-test',
      onUsage: () => { throw new Error('logger boom'); },
    });
    const res = await p.createResponse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.choices[0]!.message.content).toBe('hello');
  });

  test('fires on embeddings with kind: embedding + completion_tokens zeroed', async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const p = createOpenAICompatProvider({
      name: 'stub',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'sk-test',
      onUsage: (s) => { snapshots.push({ ...s }); },
    });
    await p.createEmbeddings?.({
      model: 'text-embedding-3-small',
      input: 'abc',
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.kind).toBe('embedding');
    expect(snapshots[0]!.completion_tokens).toBe(0);
    expect(snapshots[0]!.prompt_tokens).toBe(3); // input length
  });

  test('fires on streaming when upstream emits a usage frame', async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const p = createOpenAICompatProvider({
      name: 'stub',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'sk-test',
      onUsage: (s) => { snapshots.push({ ...s }); },
    });
    const request = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user' as const, content: 'hi' }],
      providerOptions: { stream_options: { include_usage: true } },
    };
    for await (const _ev of p.streamResponse?.(request) ?? []) {
      // drain
      void _ev;
    }
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.prompt_tokens).toBe(4);
    expect(snapshots[0]!.completion_tokens).toBe(2);
    expect(snapshots[0]!.total_tokens).toBe(6);
  });

  test('does NOT fire on streaming when upstream omits the usage frame', async () => {
    const snapshots: Array<Record<string, unknown>> = [];
    const p = createOpenAICompatProvider({
      name: 'stub',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'sk-test',
      onUsage: (s) => { snapshots.push({ ...s }); },
    });
    for await (const _ev of p.streamResponse?.({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }) ?? []) {
      void _ev;
    }
    expect(snapshots).toHaveLength(0);
  });
});
