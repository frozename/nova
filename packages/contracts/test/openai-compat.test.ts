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
        const body = (await req.json()) as { stream?: boolean; model: string };
        if (body.stream) {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
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
});
