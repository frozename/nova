import type { AiProvider } from '../provider.js';
import type { ModelInfo } from '../schemas/models.js';
import type { ProviderHealth } from '../schemas/health.js';
import type { UnifiedAiRequest, UnifiedAiResponse } from '../schemas/chat.js';
import type {
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from '../schemas/embeddings.js';
import type { UnifiedStreamEvent } from '../schemas/stream.js';

/**
 * OpenAI-compatible provider adapter. Covers every upstream that
 * speaks the OpenAI REST dialect unchanged — OpenAI itself, Together,
 * groq, Mistral, any self-hosted llama-server behind this agent.
 * Adapters for dialect-diverging providers (Anthropic native, Cohere,
 * Gemini) will live alongside this file and implement the same
 * `AiProvider` interface.
 *
 * Kept deliberately thin: no retry loop, no failover, no logging —
 * those belong in the orchestrator (llamactl's dispatcher,
 * sirius-gateway's fallback chain) that composes providers.
 */

export interface OpenAICompatOptions {
  /** Provider name used in metadata + telemetry labels. */
  name: string;
  displayName?: string;
  /** e.g. `https://api.openai.com/v1`. Trailing slash tolerated. */
  baseUrl: string;
  /** Bearer token. Passed as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Optional fetch override for tests or runtime-specific TLS pinning. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request (e.g. `OpenAI-Organization`). */
  extraHeaders?: Record<string, string>;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function createOpenAICompatProvider(opts: OpenAICompatOptions): AiProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = trimTrailingSlash(opts.baseUrl);
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  });

  async function call(path: string, init: RequestInit): Promise<Response> {
    return fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...headers(), ...((init.headers as Record<string, string>) ?? {}) },
    });
  }

  return {
    name: opts.name,
    displayName: opts.displayName ?? opts.name,

    async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
      const startedAt = Date.now();
      // Strip nova-only fields before sending upstream.
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const res = await call('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${opts.name} ${res.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedAiResponse;
      return {
        ...raw,
        latencyMs: Date.now() - startedAt,
        provider: opts.name,
      };
    },

    async *streamResponse(
      request: UnifiedAiRequest,
      signal?: AbortSignal,
    ): AsyncIterable<UnifiedStreamEvent> {
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}), stream: true };
      const res = await call('/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        yield {
          type: 'error',
          error: {
            message: `${opts.name} ${res.status}: ${text.slice(0, 500)}`,
            code: String(res.status),
            retryable: res.status >= 500 || res.status === 429,
          },
        };
        return;
      }
      if (!res.body) {
        yield { type: 'done', finish_reason: 'stop' };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFinish: UnifiedStreamEvent = { type: 'done', finish_reason: 'stop' };
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // OpenAI SSE frames are separated by blank lines; each frame
        // is a `data: {...}` line (plus `event:` in some dialects).
        let nl: number;
        while ((nl = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 2);
          if (!frame.startsWith('data:')) continue;
          const payload = frame.slice(5).trim();
          if (payload === '[DONE]') {
            yield lastFinish;
            return;
          }
          try {
            const chunk = JSON.parse(payload) as {
              id?: string;
              object?: string;
              model?: string;
              created?: number;
              choices?: Array<{
                index?: number;
                delta?: { role?: 'assistant' | 'tool'; content?: string | null; tool_calls?: unknown };
                finish_reason?: string | null;
              }>;
            };
            if (!chunk.choices) continue;
            const finish = chunk.choices[0]?.finish_reason;
            if (finish) {
              lastFinish = {
                type: 'done',
                finish_reason: finish as UnifiedStreamEvent extends { type: 'done'; finish_reason: infer F } ? F : never,
              };
            }
            yield {
              type: 'chunk',
              chunk: {
                id: chunk.id ?? '',
                object: 'chat.completion.chunk',
                model: chunk.model ?? request.model,
                created: chunk.created ?? Math.floor(Date.now() / 1000),
                choices: chunk.choices.map((c) => ({
                  index: c.index ?? 0,
                  delta: {
                    ...(c.delta?.role ? { role: c.delta.role } : {}),
                    ...(c.delta?.content !== undefined ? { content: c.delta.content } : {}),
                  },
                  ...(c.finish_reason !== undefined
                    ? { finish_reason: c.finish_reason as UnifiedStreamEvent extends { type: 'done'; finish_reason: infer F } ? F : never }
                    : {}),
                })),
              },
            };
          } catch {
            // Ignore non-JSON data lines; some providers emit keep-alives.
          }
        }
      }
      yield lastFinish;
    },

    async createEmbeddings(
      request: UnifiedEmbeddingRequest,
    ): Promise<UnifiedEmbeddingResponse> {
      const startedAt = Date.now();
      const { providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const res = await call('/embeddings', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${opts.name} ${res.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedEmbeddingResponse;
      return {
        ...raw,
        latencyMs: Date.now() - startedAt,
        provider: opts.name,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await call('/models', { method: 'GET' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${opts.name} /models ${res.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as { data?: Array<{ id?: string; created?: number; owned_by?: string }> };
      const now = Math.floor(Date.now() / 1000);
      return (raw.data ?? []).map((m) => ({
        id: String(m.id ?? ''),
        object: 'model' as const,
        created: m.created ?? now,
        owned_by: m.owned_by ?? opts.name,
        capabilities: ['chat' as const],
      }));
    },

    async healthCheck(): Promise<ProviderHealth> {
      const startedAt = Date.now();
      try {
        const res = await call('/models', { method: 'GET' });
        const latencyMs = Date.now() - startedAt;
        if (!res.ok) {
          return {
            state: res.status >= 500 ? 'unhealthy' : 'degraded',
            lastChecked: new Date().toISOString(),
            latencyMs,
            error: `HTTP ${res.status}`,
          };
        }
        return {
          state: 'healthy',
          lastChecked: new Date().toISOString(),
          latencyMs,
        };
      } catch (err) {
        return {
          state: 'unhealthy',
          lastChecked: new Date().toISOString(),
          error: (err as Error).message,
        };
      }
    },
  };
}
