import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { UnifiedStreamEvent } from "../src/index.js";

import { UnifiedAiResponseSchema, UnifiedStreamEventSchema } from "../src/index.js";
import { createOpenAICompatProvider, mergeRequestHeaders } from "../src/providers/openai-compat.js";

type Observation = {
  provider?: string;
  model?: string;
  kind?: string;
  latency_ms?: number;
  request_id?: string;
  attempt_id?: string;
  observation?: Record<string, unknown>;
};

function collectObservations(): {
  observations: Observation[];
  onUsageObservation: (o: unknown) => void;
} {
  const observations: Observation[] = [];
  return {
    observations,
    onUsageObservation: (o): void => {
      observations.push(JSON.parse(JSON.stringify(o)) as Observation);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json({
          data: [
            { id: "gpt-4o-mini", created: 1700000000, owned_by: "openai" },
            { id: "gpt-4o", created: 1700000000, owned_by: "openai" },
          ],
        });
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as {
          stream?: boolean;
          model: string;
          tools?: unknown[];
          stream_options?: { include_usage?: boolean };
        };
        if (body.stream) {
          const toolCallRun = Array.isArray(body.tools) && body.tools.length > 0;
          const stream = new ReadableStream({
            start(controller): void {
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
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          model: body.model,
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        });
      }
      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        const body = (await req.json()) as { model: string; input: string };
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: body.model,
          usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  void upstream?.stop(true);
});

function makeProvider(): ReturnType<typeof createOpenAICompatProvider> {
  return createOpenAICompatProvider({
    name: "stub",
    displayName: "Stub",
    baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
    apiKey: "sk-test",
  });
}

/** Serves the given SSE byte frames then closes the stream. */
function sseServer(frames: string[]): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller): void {
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port!,
    stop: (): void => {
      void server.stop(true);
    },
  };
}

/** Serves the given SSE frames then stays open — the stream never ends. */
function hangingSseServer(frames: string[]): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller): void {
          for (const f of frames) controller.enqueue(enc.encode(f));
          // Stream stays open — no [DONE], no more data.
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port!,
    stop: (): void => {
      void server.stop(true);
    },
  };
}

async function drainEvents(port: number): Promise<UnifiedStreamEvent[]> {
  const p = createOpenAICompatProvider({
    name: "sse",
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    apiKey: "sk",
  });
  const events: UnifiedStreamEvent[] = [];
  for await (const ev of p.streamResponse?.({
    model: "m",
    messages: [{ role: "user", content: "x" }],
  }) ?? []) {
    events.push(ev);
  }
  return events;
}

describe("openai-compat provider", () => {
  test("listModels round-trips canonical ModelInfo", async () => {
    const p = makeProvider();
    const models = await p.listModels?.();
    expect(models).toHaveLength(2);
    expect(models?.[0]?.id).toBe("gpt-4o-mini");
    expect(models?.[0]?.object).toBe("model");
    expect(models?.[0]?.capabilities).toContain("chat");
  });

  test("createResponse includes latency + provider annotation", async () => {
    const p = makeProvider();
    const res = await p.createResponse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.choices[0]!.message.content).toBe("hello");
    expect(res.provider).toBe("stub");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.usage?.total_tokens).toBe(3);
  });

  test("streamResponse yields chunks then a done event", async () => {
    const p = makeProvider();
    const events: unknown[] = [];
    for await (const ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }) ?? []) {
      events.push(ev);
    }
    const chunks = events.filter(
      (e): e is { type: "chunk"; chunk: { choices: [{ delta: { content?: string } }] } } =>
        (e as { type?: string }).type === "chunk",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const joined = chunks.map((c) => c.chunk.choices[0].delta.content ?? "").join("");
    expect(joined).toBe("hello");
    const lastEvent = events[events.length - 1] as { type: string };
    expect(lastEvent.type).toBe("done");
  });

  test("createEmbeddings passes input + annotates provider", async () => {
    const p = makeProvider();
    const res = await p.createEmbeddings?.({
      model: "text-embedding-3-small",
      input: "abc",
    });
    expect(res?.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res?.provider).toBe("stub");
  });

  test("healthCheck reports healthy against a live upstream", async () => {
    const p = makeProvider();
    const h = await p.healthCheck?.();
    expect(h?.state).toBe("healthy");
    expect(h?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("healthCheck reports unhealthy when upstream is down", async () => {
    const bad = createOpenAICompatProvider({
      name: "dead",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "x",
    });
    const h = await bad.healthCheck?.();
    expect(h?.state).toBe("unhealthy");
    expect(h?.error).toBeTruthy();
  });

  test("healthCheck honors healthPath for self-hosted /health endpoints", async () => {
    const p = createOpenAICompatProvider({
      name: "local",
      // Root baseUrl — /health sits outside /v1 on self-hosted gateways.
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}`,
      apiKey: "x",
      healthPath: "/health",
    });
    const h = await p.healthCheck?.();
    expect(h?.state).toBe("healthy");
  });

  test("streamResponse preserves tool_call deltas", async () => {
    const p = makeProvider();
    const events: unknown[] = [];
    for await (const ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "call the search tool" }],
      tools: [
        {
          type: "function",
          function: { name: "search", description: "search the web", parameters: {} },
        },
      ],
    }) ?? []) {
      events.push(ev);
    }
    const chunks = events.filter(
      (
        e,
      ): e is {
        type: "chunk";
        chunk: {
          choices: {
            delta: {
              tool_calls?: {
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
        };
      } => (e as { type?: string }).type === "chunk",
    );
    // Every chunk with tool_calls preserves the `index` field.
    const allToolCallFrames = chunks.flatMap((c) => c.chunk.choices[0]?.delta.tool_calls ?? []);
    expect(allToolCallFrames.length).toBeGreaterThanOrEqual(2);
    // First frame carries the id + name, subsequent frames carry arguments.
    expect(allToolCallFrames[0]?.id).toBe("call_1");
    expect(allToolCallFrames[0]?.function?.name).toBe("search");
    const joinedArgs = allToolCallFrames.map((f) => f.function?.arguments ?? "").join("");
    expect(joinedArgs).toContain("hi");
    const lastEvent = events[events.length - 1] as { type: string; finish_reason?: string };
    expect(lastEvent.type).toBe("done");
    expect(lastEvent.finish_reason).toBe("tool_calls");
  });
});

describe("openai-compat provider — onUsage callback", () => {
  test("fires on non-streaming chat with provider + model + token counts", async () => {
    const snapshots: Record<string, unknown>[] = [];
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: (s) => {
        snapshots.push({ ...s });
      },
    });
    await p.createResponse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!["provider"]).toBe("stub");
    expect(snapshots[0]!["model"]).toBe("gpt-4o-mini");
    expect(snapshots[0]!["kind"]).toBe("chat");
    expect(snapshots[0]!["prompt_tokens"]).toBe(2);
    expect(snapshots[0]!["completion_tokens"]).toBe(1);
    expect(snapshots[0]!["total_tokens"]).toBe(3);
    expect(typeof snapshots[0]!["latency_ms"]).toBe("number");
  });

  test("does not fire when the provider omits `usage`", async () => {
    const noUsagePort = UPSTREAM_PORT + 1;
    const server = Bun.serve({
      port: noUsagePort,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          const body = (await req.json()) as { model: string };
          return Response.json({
            id: "x",
            object: "chat.completion",
            model: body.model,
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            // usage deliberately omitted
          });
        }
        return new Response("", { status: 404 });
      },
    });
    try {
      const snapshots: Record<string, unknown>[] = [];
      const p = createOpenAICompatProvider({
        name: "no-usage",
        baseUrl: `http://127.0.0.1:${String(noUsagePort)}/v1`,
        apiKey: "sk",
        onUsage: (s) => {
          snapshots.push({ ...s });
        },
      });
      await p.createResponse({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });
      expect(snapshots).toHaveLength(0);
    } finally {
      void server.stop(true);
    }
  });

  test("onUsage throw does not bleed into the response path", async () => {
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: () => {
        throw new Error("logger boom");
      },
    });
    const res = await p.createResponse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.choices[0]!.message.content).toBe("hello");
  });

  test("fires on embeddings with kind: embedding + completion_tokens zeroed", async () => {
    const snapshots: Record<string, unknown>[] = [];
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: (s) => {
        snapshots.push({ ...s });
      },
    });
    await p.createEmbeddings?.({
      model: "text-embedding-3-small",
      input: "abc",
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!["kind"]).toBe("embedding");
    expect(snapshots[0]!["completion_tokens"]).toBe(0);
    expect(snapshots[0]!["prompt_tokens"]).toBe(3); // input length
  });

  test("fires on streaming when upstream emits a usage frame", async () => {
    const snapshots: Record<string, unknown>[] = [];
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: (s) => {
        snapshots.push({ ...s });
      },
    });
    const request = {
      model: "gpt-4o-mini",
      messages: [{ role: "user" as const, content: "hi" }],
      providerOptions: { stream_options: { include_usage: true } },
    };
    for await (const _ev of p.streamResponse?.(request) ?? []) {
      // drain
      void _ev;
    }
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!["prompt_tokens"]).toBe(4);
    expect(snapshots[0]!["completion_tokens"]).toBe(2);
    expect(snapshots[0]!["total_tokens"]).toBe(6);
  });

  test("does NOT fire on streaming when upstream omits the usage frame", async () => {
    const snapshots: Record<string, unknown>[] = [];
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: (s) => {
        snapshots.push({ ...s });
      },
    });
    for await (const _ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }) ?? []) {
      void _ev;
    }
    expect(snapshots).toHaveLength(0);
  });
});

describe("openai-compat — onUsageObservation callback", () => {
  test("nonstream: observed usage maps to input/output/total + upstream_request_id", async () => {
    const { observations, onUsageObservation } = collectObservations();
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation,
    });
    await p.createResponse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(observations).toHaveLength(1);
    const o = observations[0]!;
    expect(o.provider).toBe("stub");
    expect(o.model).toBe("gpt-4o-mini");
    expect(o.kind).toBe("chat");
    expect(typeof o.latency_ms).toBe("number");
    const obs = o.observation!;
    expect(obs["source"]).toBe("observed");
    expect(obs["input_tokens"]).toBe(2);
    expect(obs["output_tokens"]).toBe(1);
    expect(obs["total_tokens"]).toBe(3);
    expect(obs["upstream_request_id"]).toBe("chatcmpl-stub");
  });

  test("nonstream: missing usage → source unknown with no counts", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          return Response.json({
            id: "chatcmpl-nousage",
            object: "chat.completion",
            model: "m",
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          });
        }
        return new Response("", { status: 404 });
      },
    });
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "no-usage",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      await p.createResponse({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("unknown");
      expect(obs["input_tokens"]).toBeUndefined();
      expect(obs["output_tokens"]).toBeUndefined();
      expect(obs["total_tokens"]).toBeUndefined();
    } finally {
      void server.stop(true);
    }
  });

  test("nonstream: execution context requestId/attemptId propagate to the observation", async () => {
    const { observations, onUsageObservation } = collectObservations();
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation,
    });
    await p.createResponse(
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      { requestId: "req_42", attemptId: "attempt_3" },
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]!.request_id).toBe("req_42");
    expect(observations[0]!.attempt_id).toBe("attempt_3");
  });

  test("stream: usage-only empty-choices frame fires an observed observation", async () => {
    const { observations, onUsageObservation } = collectObservations();
    const snapshots: Record<string, unknown>[] = [];
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsage: (s) => {
        snapshots.push({ ...s });
      },
      onUsageObservation,
    });
    const request = {
      model: "gpt-4o-mini",
      messages: [{ role: "user" as const, content: "hi" }],
      providerOptions: { stream_options: { include_usage: true } },
    };
    for await (const _ev of p.streamResponse?.(request) ?? []) {
      void _ev;
    }
    // Upstream emitted a `choices: []` + `usage` frame (see fixture).
    expect(observations).toHaveLength(1);
    const obs = observations[0]!.observation!;
    expect(obs["source"]).toBe("observed");
    expect(obs["input_tokens"]).toBe(4);
    expect(obs["output_tokens"]).toBe(2);
    expect(obs["total_tokens"]).toBe(6);
    // Legacy onUsage path unchanged.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!["total_tokens"]).toBe(6);
  });

  test("stream: partial usage frame reports only present counts — no fabricated zeros", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/chat/completions") {
          return new Response("", { status: 404 });
        }
        const body = (await req.json()) as { model: string };
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller): void {
            controller.enqueue(
              enc.encode(
                `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${body.model}","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}\n\n`,
              ),
            );
            // Usage frame with ONLY prompt_tokens — completion/total absent.
            controller.enqueue(
              enc.encode(
                `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${body.model}","choices":[],"usage":{"prompt_tokens":5}}\n\n`,
              ),
            );
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const { observations, onUsageObservation } = collectObservations();
      const snapshots: Record<string, unknown>[] = [];
      const p = createOpenAICompatProvider({
        name: "partial",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
        onUsage: (s) => {
          snapshots.push({ ...s });
        },
        onUsageObservation,
      });
      for await (const _ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        void _ev;
      }
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(5);
      expect(obs["output_tokens"]).toBeUndefined();
      expect(obs["total_tokens"]).toBeUndefined();
      // Legacy onUsage keeps its zero-fill contract.
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!["prompt_tokens"]).toBe(5);
      expect(snapshots[0]!["completion_tokens"]).toBe(0);
      expect(snapshots[0]!["total_tokens"]).toBe(0);
    } finally {
      void server.stop(true);
    }
  });

  test("stream: no usage frame → unknown observation fires at stream end", async () => {
    const { observations, onUsageObservation } = collectObservations();
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation,
    });
    for await (const _ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }) ?? []) {
      void _ev;
    }
    expect(observations).toHaveLength(1);
    const obs = observations[0]!.observation!;
    expect(obs["source"]).toBe("unknown");
    expect(obs["input_tokens"]).toBeUndefined();
  });

  test("embeddings: reports only the counts the upstream sent", async () => {
    const { observations, onUsageObservation } = collectObservations();
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation,
    });
    await p.createEmbeddings?.({
      model: "text-embedding-3-small",
      input: "abc",
    });
    expect(observations).toHaveLength(1);
    const o = observations[0]!;
    expect(o.kind).toBe("embedding");
    const obs = o.observation!;
    expect(obs["source"]).toBe("observed");
    expect(obs["input_tokens"]).toBe(3);
    expect(obs["total_tokens"]).toBe(3);
    // Upstream sent no completion count — must stay absent, not 0.
    expect(obs["output_tokens"]).toBeUndefined();
  });

  test("stream: cumulative usage on every chunk → exactly one observation, last frame wins", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"a"}}],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const snapshots: Record<string, unknown>[] = [];
      const p = createOpenAICompatProvider({
        name: "cumulative",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsage: (s) => {
          snapshots.push({ ...s });
        },
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        void ev;
      }
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(1);
      expect(obs["output_tokens"]).toBe(2);
      expect(obs["total_tokens"]).toBe(3);
      // The legacy onUsage contract is unchanged: one call per usage frame.
      expect(snapshots).toHaveLength(2);
    } finally {
      stop();
    }
  });

  test("stream: consumer break after a usage frame → exactly one observation with the last usage", async () => {
    const { port, stop } = hangingSseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "brk",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        expect(ev.type).toBe("chunk");
        break;
      }
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(3);
      expect(obs["output_tokens"]).toBe(1);
      expect(obs["total_tokens"]).toBe(4);
    } finally {
      stop();
    }
  });

  test("stream: consumer break before any usage frame → exactly one unknown observation", async () => {
    const { port, stop } = hangingSseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "brk",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        expect(ev.type).toBe("chunk");
        break;
      }
      expect(observations).toHaveLength(1);
      expect(observations[0]!.observation!["source"]).toBe("unknown");
    } finally {
      stop();
    }
  });

  test("stream: an SSE error frame still fires exactly one observation", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"x"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
      'data: {"error":{"message":"boom","code":"server_error"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "err",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const events: UnifiedStreamEvent[] = [];
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        events.push(ev);
      }
      expect(events[events.length - 1]!.type).toBe("error");
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(2);
      expect(obs["total_tokens"]).toBe(3);
    } finally {
      stop();
    }
  });

  test("stream: EOF truncation still fires exactly one observation", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      // truncated — no [DONE]
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "eof",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        void ev;
      }
      expect(observations).toHaveLength(1);
      expect(observations[0]!.observation!["source"]).toBe("unknown");
    } finally {
      stop();
    }
  });

  test("stream: a usage frame with no numeric counts maps to source unknown", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "empty-usage",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        void ev;
      }
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("unknown");
      expect(obs["input_tokens"]).toBeUndefined();
      expect(obs["output_tokens"]).toBeUndefined();
      expect(obs["total_tokens"]).toBeUndefined();
    } finally {
      stop();
    }
  });

  test("a throwing onUsageObservation is swallowed — createResponse still resolves", async () => {
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation: () => {
        throw new Error("sink boom");
      },
    });
    const res = await p.createResponse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.choices[0]!.message.content).toBe("hello");
  });

  test("a throwing onUsageObservation is swallowed — stream still completes", async () => {
    const p = createOpenAICompatProvider({
      name: "stub",
      baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
      apiKey: "sk-test",
      onUsageObservation: () => {
        throw new Error("sink boom");
      },
    });
    const events: UnifiedStreamEvent[] = [];
    for await (const ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    }) ?? []) {
      events.push(ev);
    }
    expect(events[events.length - 1]!.type).toBe("done");
  });
});

describe("openai-compat — ProviderExecutionContext (nonstream cancellation)", () => {
  test("createResponse aborts the in-flight request when signal fires", async () => {
    let serverAborted = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          serverAborted = true;
        });
        return new Promise<Response>(() => {
          /* The pending response exercises cancellation without a timeout. */
        });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "hang",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      const ac = new AbortController();
      const outcomeP = p
        .createResponse(
          { model: "m", messages: [{ role: "user", content: "x" }] },
          { signal: ac.signal },
        )
        .then(
          () => "resolved" as const,
          (e: unknown) => `rejected:${(e as Error).name}`,
        );
      await sleep(60);
      ac.abort();
      const outcome = await Promise.race([outcomeP, sleep(1500).then(() => "pending" as const)]);
      expect(outcome).toBe("rejected:AbortError");
      await sleep(80);
      expect(serverAborted).toBe(true);
    } finally {
      void server.stop(true);
    }
  });

  test("createResponse aborts when the deadline passes mid-flight", async () => {
    let serverAborted = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          serverAborted = true;
        });
        return new Promise<Response>(() => {
          /* The pending response exercises cancellation without a timeout. */
        });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "hang",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      const outcomeP = p
        .createResponse(
          { model: "m", messages: [{ role: "user", content: "x" }] },
          { deadline: Date.now() + 60 },
        )
        .then(
          () => "resolved" as const,
          (e: unknown) => `rejected:${(e as Error).name}`,
        );
      const outcome = await Promise.race([outcomeP, sleep(1500).then(() => "pending" as const)]);
      // AbortSignal.timeout rejects with TimeoutError.
      expect(outcome).toBe("rejected:TimeoutError");
      await sleep(80);
      expect(serverAborted).toBe(true);
    } finally {
      void server.stop(true);
    }
  });

  test("createResponse with an already-expired deadline rejects without waiting", async () => {
    let sawRequest = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        sawRequest = true;
        return Response.json({ id: "x" });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "deadline",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      const outcome = await p
        .createResponse(
          { model: "m", messages: [{ role: "user", content: "x" }] },
          { deadline: Date.now() - 1000 },
        )
        .then(
          () => "resolved" as const,
          (e: unknown) => `rejected:${(e as Error).name}`,
        );
      expect(outcome).toBe("rejected:TimeoutError");
      expect(sawRequest).toBe(false);
    } finally {
      void server.stop(true);
    }
  });

  test("createEmbeddings honors the context signal", async () => {
    let serverAborted = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          serverAborted = true;
        });
        return new Promise<Response>(() => {
          /* The pending response exercises cancellation without a timeout. */
        });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "hang",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      const ac = new AbortController();
      const outcomeP = p.createEmbeddings?.({ model: "e", input: "x" }, { signal: ac.signal }).then(
        () => "resolved" as const,
        (e: unknown) => `rejected:${(e as Error).name}`,
      );
      await sleep(60);
      ac.abort();
      const outcome = await Promise.race([outcomeP, sleep(1500).then(() => "pending" as const)]);
      expect(outcome).toBe("rejected:AbortError");
      await sleep(80);
      expect(serverAborted).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});

describe("openai-compat — stream caller abort", () => {
  test("caller abort during a pending read throws AbortError — no done, one observation", async () => {
    const { port, stop } = hangingSseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "abort",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const ac = new AbortController();
      const yielded: UnifiedStreamEvent[] = [];
      const it = p.streamResponse!(
        { model: "m", messages: [{ role: "user", content: "x" }] },
        ac.signal,
      )[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) yielded.push(first.value);
      const pending = it.next();
      ac.abort();
      const outcome = await pending.then(
        (r) => `resolved:${String(r.done)}`,
        (e: unknown) => `threw:${(e as Error).name}`,
      );
      expect(outcome).toBe("threw:AbortError");
      expect(yielded.map((e) => e.type)).toEqual(["chunk"]);
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("caller abort while suspended at a yield throws AbortError — no done, one observation", async () => {
    const { port, stop } = hangingSseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "abort",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const ac = new AbortController();
      const yielded: UnifiedStreamEvent[] = [];
      const it = p.streamResponse!(
        { model: "m", messages: [{ role: "user", content: "x" }] },
        ac.signal,
      )[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) yielded.push(first.value);
      // The generator is now suspended at the chunk's yield.
      ac.abort();
      const outcome = await it.next().then(
        (r) => `resolved:${String(r.done)}`,
        (e: unknown) => `threw:${(e as Error).name}`,
      );
      expect(outcome).toBe("threw:AbortError");
      expect(yielded.map((e) => e.type)).toEqual(["chunk"]);
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("openai-compat — stream client-return cleanup", () => {
  test("breaking out of the async iterator releases the upstream request", async () => {
    let released = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        req.signal.addEventListener("abort", () => {
          released = true;
        });
        const stream = new ReadableStream({
          start(controller): void {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
              ),
            );
            // Stream stays open — no [DONE], no more data.
          },
          cancel(): void {
            released = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "stream-hang",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        expect(ev.type).toBe("chunk");
        break;
      }
      await sleep(400);
      expect(released).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});

describe("openai-compat — stream terminal evidence", () => {
  type DoneEvent = { type: "done"; finish_reason: unknown; completion?: string };

  test("real [DONE] frame → done marked as upstream-completed", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      const done = events[events.length - 1] as DoneEvent;
      expect(done.type).toBe("done");
      expect(done.completion).toBe("upstream");
    } finally {
      stop();
    }
  });

  test("finish_reason then EOF without [DONE] → still upstream-completed", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
      // connection closes — no [DONE]
    ]);
    try {
      const events = await drainEvents(port);
      const done = events[events.length - 1] as DoneEvent;
      expect(done.type).toBe("done");
      expect(done.finish_reason).toBe("stop");
      expect(done.completion).toBe("upstream");
    } finally {
      stop();
    }
  });

  test("EOF with no finish signal → done marked eof, not upstream", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      // EOF — stream truncated mid-response
    ]);
    try {
      const events = await drainEvents(port);
      const done = events[events.length - 1] as DoneEvent;
      expect(done.type).toBe("done");
      expect(done.completion).toBe("eof");
      expect(done.completion).not.toBe("upstream");
    } finally {
      stop();
    }
  });

  test("malformed frame then EOF → done not marked upstream", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      "data: {not valid json\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      const done = events[events.length - 1] as DoneEvent;
      expect(done.type).toBe("done");
      expect(done.completion).toBe("eof");
      expect(done.completion).not.toBe("upstream");
    } finally {
      stop();
    }
  });

  test("HTTP error → error event only; no done claims upstream completion", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("upstream exploded", { status: 500 });
      },
    });
    try {
      const p = createOpenAICompatProvider({
        name: "err",
        baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
        apiKey: "sk",
      });
      const events: UnifiedStreamEvent[] = [];
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        events.push(ev);
      }
      const errorEvents = events.filter((e) => e.type === "error");
      const doneEvents = events.filter(
        (e): e is Extract<UnifiedStreamEvent, { type: "done" }> => e.type === "done",
      );
      expect(errorEvents).toHaveLength(1);
      for (const d of doneEvents) {
        expect((d as unknown as { completion?: string }).completion).not.toBe("upstream");
      }
    } finally {
      void server.stop(true);
    }
  });

  test("SSE error frame then [DONE] → one error event, stream terminates, no done", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"error":{"message":"bad upstream","code":"server_error"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["chunk", "error"]);
      const err = events[1] as Extract<UnifiedStreamEvent, { type: "error" }>;
      expect(err.error.message).toBe("bad upstream");
      expect(err.error.code).toBe("server_error");
      expect(err.error.retryable).toBe(true);
    } finally {
      stop();
    }
  });

  test("SSE error frame then EOF → error event, still no done", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"error":{"message":"mid-stream boom","type":"invalid_api_key"}}\n\n',
      // connection closes with no [DONE]
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["chunk", "error"]);
      const err = events[1] as Extract<UnifiedStreamEvent, { type: "error" }>;
      expect(err.error.message).toBe("mid-stream boom");
      // code falls back to the error's `type` when `code` is absent.
      expect(err.error.code).toBe("invalid_api_key");
      expect(err.error.retryable).toBe(false);
    } finally {
      stop();
    }
  });

  test("SSE error frame as a bare string → error event, no done", async () => {
    const { port, stop } = sseServer([
      'data: {"error":"upstream exploded"}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["error"]);
      const err = events[0] as Extract<UnifiedStreamEvent, { type: "error" }>;
      expect(err.error.message).toBe("upstream exploded");
      expect(err.error.retryable).toBe(false);
    } finally {
      stop();
    }
  });

  test("SSE error frame with a rate-limit code → retryable", async () => {
    const { port, stop } = sseServer([
      'data: {"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n',
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["error"]);
      const err = events[0] as Extract<UnifiedStreamEvent, { type: "error" }>;
      expect(err.error.code).toBe("rate_limit_exceeded");
      expect(err.error.retryable).toBe(true);
    } finally {
      stop();
    }
  });

  test("[DONE] without a trailing blank line still marks upstream completion", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]", // no trailing \n\n — the transport just closes
    ]);
    try {
      const events = await drainEvents(port);
      const done = events[events.length - 1] as DoneEvent;
      expect(done.type).toBe("done");
      expect(done.completion).toBe("upstream");
    } finally {
      stop();
    }
  });

  test("a trailing data frame without a blank line is still delivered", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"tail"},"finish_reason":"stop"}]}',
      // no trailing newline at all
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["chunk", "done"]);
      const done = events[1] as DoneEvent;
      expect(done.finish_reason).toBe("stop");
      expect(done.completion).toBe("upstream");
    } finally {
      stop();
    }
  });

  test("a usage-only frame emits no chunk — exact event list", async () => {
    // The shared stub emits chunk, chunk, a `choices: []` + usage frame, then [DONE].
    const p = makeProvider();
    const events: UnifiedStreamEvent[] = [];
    for await (const ev of p.streamResponse?.({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { stream_options: { include_usage: true } },
    }) ?? []) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["chunk", "chunk", "done"]);
    for (const e of events) {
      if (e.type === "chunk") {
        expect(e.chunk.choices.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("openai-compat — abort with buffered terminal frames", () => {
  // chunk + terminal frame delivered in ONE enqueued write, so the
  // terminal frame is sitting in the frame buffer while the generator
  // is suspended at the chunk's yield.
  test("abort while suspended with [DONE] buffered throws AbortError — never yields done", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "abort-done",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const ac = new AbortController();
      const yielded: UnifiedStreamEvent[] = [];
      const it = p.streamResponse!(
        { model: "m", messages: [{ role: "user", content: "x" }] },
        ac.signal,
      )[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) yielded.push(first.value);
      ac.abort();
      const outcome = await it.next().then(
        (r) =>
          `resolved:${String(r.done)}:${String((r.value as { type?: string } | undefined)?.type)}`,
        (e: unknown) => `threw:${(e as Error).name}`,
      );
      expect(outcome).toBe("threw:AbortError");
      expect(yielded.map((e) => e.type)).toEqual(["chunk"]);
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("abort while suspended with an error frame buffered throws AbortError — no error yielded", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: {"error":{"message":"boom","code":"server_error"}}\n\n',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "abort-err",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const ac = new AbortController();
      const yielded: UnifiedStreamEvent[] = [];
      const it = p.streamResponse!(
        { model: "m", messages: [{ role: "user", content: "x" }] },
        ac.signal,
      )[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) yielded.push(first.value);
      ac.abort();
      const outcome = await it.next().then(
        (r) =>
          `resolved:${String(r.done)}:${String((r.value as { type?: string } | undefined)?.type)}`,
        (e: unknown) => `threw:${(e as Error).name}`,
      );
      expect(outcome).toBe("threw:AbortError");
      expect(yielded.map((e) => e.type)).toEqual(["chunk"]);
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("abort while suspended with [DONE] buffered in the EOF residual throws AbortError", async () => {
    // No trailing blank line — [DONE] is only reached via the
    // residual-buffer loop after EOF.
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\ndata: [DONE]',
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "abort-resid",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const ac = new AbortController();
      const yielded: UnifiedStreamEvent[] = [];
      const it = p.streamResponse!(
        { model: "m", messages: [{ role: "user", content: "x" }] },
        ac.signal,
      )[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) yielded.push(first.value);
      ac.abort();
      const outcome = await it.next().then(
        (r) =>
          `resolved:${String(r.done)}:${String((r.value as { type?: string } | undefined)?.type)}`,
        (e: unknown) => `threw:${(e as Error).name}`,
      );
      expect(outcome).toBe("threw:AbortError");
      expect(yielded.map((e) => e.type)).toEqual(["chunk"]);
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("openai-compat — error member discrimination", () => {
  test("falsy/empty error members on an otherwise healthy chunk are ignored", async () => {
    for (const shape of ["false", '""', "0", "[]", "{}"]) {
      const { port, stop } = sseServer([
        `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"}}],"error":${shape}}\n\n`,
        "data: [DONE]\n\n",
      ]);
      try {
        const events = await drainEvents(port);
        expect(events.map((e) => e.type)).toEqual(["chunk", "done"]);
      } finally {
        stop();
      }
    }
  });

  test("a bare empty-object error frame mid-stream does not terminate", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
      'data: {"error":{}}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"b"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["chunk", "chunk", "done"]);
    } finally {
      stop();
    }
  });

  test("each accepted error shape still terminates the stream", async () => {
    const cases: { frame: string; message: string; code?: string }[] = [
      { frame: '{"error":"boom"}', message: "boom" },
      { frame: '{"error":{"message":"bad"}}', message: "bad" },
      {
        frame: '{"error":{"type":"overloaded_error"}}',
        message: '{"type":"overloaded_error"}',
        code: "overloaded_error",
      },
      {
        frame: '{"error":{"code":"rate_limit_exceeded"}}',
        message: '{"code":"rate_limit_exceeded"}',
        code: "rate_limit_exceeded",
      },
    ];
    for (const c of cases) {
      const { port, stop } = sseServer([`data: ${c.frame}\n\n`, "data: [DONE]\n\n"]);
      try {
        const events = await drainEvents(port);
        expect(events.map((e) => e.type)).toEqual(["error"]);
        const err = events[0] as Extract<UnifiedStreamEvent, { type: "error" }>;
        expect(err.error.message).toBe(c.message);
        if (c.code === undefined) {
          expect(err.error.code).toBeUndefined();
        } else {
          expect(err.error.code).toBe(c.code);
        }
      } finally {
        stop();
      }
    }
  });
});

describe("openai-compat — error frame usage/content capture", () => {
  test("an error frame carrying usage still feeds the single observation", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7},"error":{"message":"boom","code":"server_error"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = createOpenAICompatProvider({
        name: "err-usage",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsageObservation,
      });
      const events: UnifiedStreamEvent[] = [];
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        events.push(ev);
      }
      expect(events.map((e) => e.type)).toEqual(["error"]);
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(5);
      expect(obs["output_tokens"]).toBe(2);
      expect(obs["total_tokens"]).toBe(7);
    } finally {
      stop();
    }
  });

  test("an error frame carrying a content delta yields the chunk before the error", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}],"error":{"message":"boom","code":"server_error"}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const events = await drainEvents(port);
      expect(events.map((e) => e.type)).toEqual(["chunk", "error"]);
      const chunk = events[0] as Extract<UnifiedStreamEvent, { type: "chunk" }>;
      expect(chunk.chunk.choices[0]?.delta.content).toBe("hi");
      const err = events[1] as Extract<UnifiedStreamEvent, { type: "error" }>;
      expect(err.error.message).toBe("boom");
    } finally {
      stop();
    }
  });
});

describe("openai-compat — usage last-wins", () => {
  test("a trailing count-less usage frame does not erase earlier observed counts", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"a"}}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{}}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const snapshots: Record<string, unknown>[] = [];
      const p = createOpenAICompatProvider({
        name: "last-wins",
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
        apiKey: "sk",
        onUsage: (s) => {
          snapshots.push({ ...s });
        },
        onUsageObservation,
      });
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        void ev;
      }
      expect(observations).toHaveLength(1);
      const obs = observations[0]!.observation!;
      expect(obs["source"]).toBe("observed");
      expect(obs["input_tokens"]).toBe(5);
      expect(obs["output_tokens"]).toBe(2);
      expect(obs["total_tokens"]).toBe(7);
      // Legacy onUsage still fires once per usage frame, count-less
      // frames included.
      expect(snapshots).toHaveLength(2);
    } finally {
      stop();
    }
  });
});

describe("openai-compat — observation ordering", () => {
  async function drainWithOrder(
    port: number,
  ): Promise<{ events: UnifiedStreamEvent[]; order: string[] }> {
    const order: string[] = [];
    const p = createOpenAICompatProvider({
      name: "ord",
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      apiKey: "sk",
      onUsageObservation: () => {
        order.push("observation");
      },
    });
    const events: UnifiedStreamEvent[] = [];
    for await (const ev of p.streamResponse?.({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    }) ?? []) {
      order.push(ev.type);
      events.push(ev);
    }
    return { events, order };
  }

  test("[DONE] path fires the observation after the done event", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    try {
      const { order } = await drainWithOrder(port);
      expect(order).toEqual(["chunk", "done", "observation"]);
    } finally {
      stop();
    }
  });

  test("EOF path fires the observation after the done event", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
      // truncated — no [DONE]
    ]);
    try {
      const { order } = await drainWithOrder(port);
      expect(order).toEqual(["chunk", "done", "observation"]);
    } finally {
      stop();
    }
  });

  test("error path fires the observation after the error event", async () => {
    const { port, stop } = sseServer([
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"error":{"message":"boom","code":"server_error"}}\n\n',
    ]);
    try {
      const { order } = await drainWithOrder(port);
      expect(order).toEqual(["chunk", "error", "observation"]);
    } finally {
      stop();
    }
  });
});

describe("openai-compat — null-body stream response", () => {
  // Bun's fetch never surfaces `res.body === null`; the documented
  // test-only fetch override drops the body after a real round-trip
  // so the !res.body path is exercised.
  function nullBodyProvider(
    port: number,
    onUsageObservation?: (o: unknown) => void,
  ): ReturnType<typeof createOpenAICompatProvider> {
    return createOpenAICompatProvider({
      name: "nullbody",
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      apiKey: "sk",
      fetch: (async (...args: Parameters<typeof globalThis.fetch>) => {
        const res = await globalThis.fetch(...args);
        return new Response(null, { status: res.status });
      }) as typeof globalThis.fetch,
      ...(onUsageObservation ? { onUsageObservation } : {}),
    });
  }

  test("yields done(eof), then the observation fires", async () => {
    const { port, stop } = sseServer([]);
    try {
      const order: string[] = [];
      const p = nullBodyProvider(port, () => {
        order.push("observation");
      });
      const events: UnifiedStreamEvent[] = [];
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        order.push(ev.type);
        events.push(ev);
      }
      expect(events).toHaveLength(1);
      const done = events[0] as { type: string; completion?: string };
      expect(done.type).toBe("done");
      expect(done.completion).toBe("eof");
      expect(order).toEqual(["done", "observation"]);
    } finally {
      stop();
    }
  });

  test("consumer break at the done yield still fires exactly one observation", async () => {
    const { port, stop } = sseServer([]);
    try {
      const { observations, onUsageObservation } = collectObservations();
      const p = nullBodyProvider(port, onUsageObservation);
      for await (const ev of p.streamResponse?.({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }) ?? []) {
        expect(ev.type).toBe("done");
        break;
      }
      expect(observations).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

describe("openai-compat provider — request header merge", () => {
  const base = {
    "content-type": "application/json",
    authorization: "Bearer sk-test",
  };

  test("Headers instance: base auth survives, caller header is added", () => {
    const merged = mergeRequestHeaders(base, new Headers({ "x-caller": "abc" }));
    expect(merged.get("authorization")).toBe("Bearer sk-test");
    expect(merged.get("content-type")).toBe("application/json");
    expect(merged.get("x-caller")).toBe("abc");
  });

  test("tuple array: base auth survives, caller header is added", () => {
    const merged = mergeRequestHeaders(base, [["x-caller", "xyz"]]);
    expect(merged.get("authorization")).toBe("Bearer sk-test");
    expect(merged.get("x-caller")).toBe("xyz");
  });

  test("caller wins on a case-insensitive collision (Headers instance)", () => {
    // Authorization (capital A) from the caller must override the base
    // lowercase authorization — Headers folds case, so this is one key.
    const merged = mergeRequestHeaders(base, new Headers({ Authorization: "Bearer override" }));
    expect(merged.get("authorization")).toBe("Bearer override");
    // Exactly one authorization header, not two.
    expect([...merged.keys()].filter((k) => k === "authorization")).toHaveLength(1);
  });

  test("caller wins on a case-insensitive collision (tuple array)", () => {
    const merged = mergeRequestHeaders(base, [["Content-Type", "text/plain"]]);
    expect(merged.get("content-type")).toBe("text/plain");
  });

  test("undefined init.headers leaves the base headers intact", () => {
    const merged = mergeRequestHeaders(base, undefined);
    expect(merged.get("authorization")).toBe("Bearer sk-test");
    expect(merged.get("content-type")).toBe("application/json");
  });

  test("both auth and a caller header reach fetchImpl end-to-end", async () => {
    let seen: Headers | undefined;
    const p = createOpenAICompatProvider({
      name: "cap",
      baseUrl: "http://x/v1",
      apiKey: "sk-e2e",
      extraHeaders: { "x-org": "acme" },
      fetch: ((_url: string | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return Promise.resolve(
          new Response(JSON.stringify({ model: "m", choices: [], usage: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof globalThis.fetch,
    });
    await p.createResponse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen?.get("authorization")).toBe("Bearer sk-e2e");
    expect(seen?.get("x-org")).toBe("acme");
    expect(seen?.get("content-type")).toBe("application/json");
  });
});

describe("openai-compat — finish_reason fallback and usage gating", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "x" }] };

  function responseBody(finishReason: string | null, usage?: Record<string, number>): object {
    return {
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [
        { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: finishReason },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  function provider(
    body: object,
    onUsage?: () => void,
  ): ReturnType<typeof createOpenAICompatProvider> {
    return createOpenAICompatProvider({
      name: "fixture",
      baseUrl: "http://fixture.invalid/v1",
      apiKey: "k",
      fetch: Object.assign(() => Promise.resolve(Response.json(body)), {
        preconnect: () => undefined,
      }),
      ...(onUsage ? { onUsage } : {}),
    });
  }

  test("stream: unknown finish_reason maps to stop", async () => {
    const frame = {
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "weird" }],
    };
    const sse = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    const p = createOpenAICompatProvider({
      name: "fixture",
      baseUrl: "http://fixture.invalid/v1",
      apiKey: "k",
      fetch: Object.assign(
        () =>
          Promise.resolve(new Response(sse, { headers: { "content-type": "text/event-stream" } })),
        { preconnect: () => undefined },
      ),
    });
    const events: UnifiedStreamEvent[] = [];
    for await (const event of p.streamResponse?.(request) ?? []) events.push(event);
    const chunk = events.find((event) => event.type === "chunk");
    const done = events.find((event) => event.type === "done");
    expect(chunk?.chunk.choices[0]?.finish_reason).toBe("stop");
    expect(done?.finish_reason).toBe("stop");
    for (const event of events)
      expect(UnifiedStreamEventSchema.safeParse(event).success).toBe(true);
  });

  test("nonstream: unknown finish_reason maps to stop", async () => {
    const result = await provider(responseBody("weird")).createResponse(request);
    expect(result.choices[0]?.finish_reason).toBe("stop");
    expect(UnifiedAiResponseSchema.safeParse(result).success).toBe(true);
  });

  test("nonstream: known finish_reason passes through", async () => {
    const result = await provider(responseBody("length")).createResponse(request);
    expect(result.choices[0]?.finish_reason).toBe("length");
  });

  test("nonstream: null finish_reason stays null", async () => {
    const result = await provider(responseBody(null)).createResponse(request);
    expect(result.choices[0]?.finish_reason).toBeNull();
  });

  test("nonstream: onUsage requires all three counts", async () => {
    let calls = 0;
    const onUsage = (): void => {
      calls++;
    };
    await provider(responseBody("stop", { prompt_tokens: 1 }), onUsage).createResponse(request);
    expect(calls).toBe(0);
    await provider(
      responseBody("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      onUsage,
    ).createResponse(request);
    expect(calls).toBe(1);
  });
});

describe("openai-compat — stream wire fidelity", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "x" }] };

  function sseProvider(body: string): ReturnType<typeof createOpenAICompatProvider> {
    return createOpenAICompatProvider({
      name: "probe",
      baseUrl: "http://probe.invalid/v1",
      apiKey: "k",
      fetch: Object.assign(
        () =>
          Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
        { preconnect: () => undefined },
      ),
    });
  }

  test("stream: intermediate null finish_reason chunk stays null", async () => {
    const sse =
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const events: UnifiedStreamEvent[] = [];
    for await (const event of sseProvider(sse).streamResponse?.(request) ?? []) {
      events.push(event);
    }
    const chunks = events.filter(
      (e): e is Extract<UnifiedStreamEvent, { type: "chunk" }> => e.type === "chunk",
    );
    expect(chunks).toHaveLength(2);
    const firstChoice = chunks[0]!.chunk.choices[0]!;
    expect(Object.hasOwn(firstChoice, "finish_reason")).toBe(true);
    expect(firstChoice).toHaveProperty("finish_reason", null);
    expect(chunks[1]!.chunk.choices[0]!.finish_reason).toBe("stop");
    const done = events.find(
      (e): e is Extract<UnifiedStreamEvent, { type: "done" }> => e.type === "done",
    );
    expect(done?.finish_reason).toBe("stop");
    for (const event of events) {
      expect(UnifiedStreamEventSchema.safeParse(event).success).toBe(true);
    }
  });

  test("SSE error frame with an object-valued code is not retryable", async () => {
    const sse =
      'data: {"error":{"message":"boom","code":{"type":"server_error"}}}\n\n' + "data: [DONE]\n\n";
    const events: UnifiedStreamEvent[] = [];
    for await (const event of sseProvider(sse).streamResponse?.(request) ?? []) {
      events.push(event);
    }
    const err = events.find(
      (e): e is Extract<UnifiedStreamEvent, { type: "error" }> => e.type === "error",
    );
    expect(err?.error.code).toBe('{"type":"server_error"}');
    expect(err?.error.retryable).toBe(false);
    for (const event of events) {
      expect(UnifiedStreamEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe("openai-compat — malformed telemetry envelope passthrough", () => {
  const request = { model: "m", messages: [{ role: "user" as const, content: "x" }] };
  const embRequest = { model: "e", input: "abc" };

  function jsonProvider(
    body: object,
    hooks: { onUsage?: () => void; onUsageObservation?: (o: unknown) => void } = {},
  ): ReturnType<typeof createOpenAICompatProvider> {
    return createOpenAICompatProvider({
      name: "probe",
      baseUrl: "http://probe.invalid/v1",
      apiKey: "k",
      fetch: Object.assign(() => Promise.resolve(Response.json(body)), {
        preconnect: () => undefined,
      }),
      ...(hooks.onUsage ? { onUsage: hooks.onUsage } : {}),
      ...(hooks.onUsageObservation ? { onUsageObservation: hooks.onUsageObservation } : {}),
    });
  }

  test("createResponse: null id/model/usage envelope body is returned intact", async () => {
    const body = {
      id: null,
      object: "chat.completion",
      created: 1,
      model: null,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: null,
    };
    const { observations, onUsageObservation } = collectObservations();
    let usageCalls = 0;
    const result = await jsonProvider(body, {
      onUsage: () => {
        usageCalls++;
      },
      onUsageObservation,
    }).createResponse(request);
    const { latencyMs, provider, ...rest } = result;
    const actual: unknown = rest;
    expect(actual).toEqual(body);
    expect(provider).toBe("probe");
    expect(typeof latencyMs).toBe("number");
    expect(usageCalls).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observation).toEqual({ source: "unknown" });
  });

  test("createResponse: non-numeric usage count body is returned intact", async () => {
    const body = {
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: "1", completion_tokens: "1", total_tokens: "2" },
    };
    const { observations, onUsageObservation } = collectObservations();
    let usageCalls = 0;
    const result = await jsonProvider(body, {
      onUsage: () => {
        usageCalls++;
      },
      onUsageObservation,
    }).createResponse(request);
    const { latencyMs, provider, ...rest } = result;
    const actual: unknown = rest;
    expect(actual).toEqual(body);
    expect(provider).toBe("probe");
    expect(typeof latencyMs).toBe("number");
    expect(usageCalls).toBe(0);
    expect(observations).toHaveLength(1);
    const obs = observations[0]!.observation!;
    expect(obs["source"]).toBe("unknown");
    expect(obs["input_tokens"]).toBeUndefined();
    expect(obs["output_tokens"]).toBeUndefined();
    expect(obs["total_tokens"]).toBeUndefined();
  });

  test("createEmbeddings: null id/model/usage envelope body is returned intact", async () => {
    const body = {
      id: null,
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      model: null,
      usage: null,
    };
    const { observations, onUsageObservation } = collectObservations();
    let usageCalls = 0;
    const result = await jsonProvider(body, {
      onUsage: () => {
        usageCalls++;
      },
      onUsageObservation,
    }).createEmbeddings?.(embRequest);
    const { latencyMs, provider, ...rest } = result!;
    const actual: unknown = rest;
    expect(actual).toEqual(body);
    expect(provider).toBe("probe");
    expect(typeof latencyMs).toBe("number");
    expect(usageCalls).toBe(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.observation).toEqual({ source: "unknown" });
  });

  test("createEmbeddings: non-numeric usage count body is returned intact", async () => {
    const body = {
      id: "e1",
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      model: "e",
      usage: { prompt_tokens: "1", completion_tokens: "1", total_tokens: "2" },
    };
    const { observations, onUsageObservation } = collectObservations();
    let usageCalls = 0;
    const result = await jsonProvider(body, {
      onUsage: () => {
        usageCalls++;
      },
      onUsageObservation,
    }).createEmbeddings?.(embRequest);
    const { latencyMs, provider, ...rest } = result!;
    const actual: unknown = rest;
    expect(actual).toEqual(body);
    expect(provider).toBe("probe");
    expect(typeof latencyMs).toBe("number");
    expect(usageCalls).toBe(0);
    expect(observations).toHaveLength(1);
    const obs = observations[0]!.observation!;
    expect(obs["source"]).toBe("unknown");
    expect(obs["input_tokens"]).toBeUndefined();
    expect(obs["output_tokens"]).toBeUndefined();
    expect(obs["total_tokens"]).toBeUndefined();
  });
});
