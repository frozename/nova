import type { AiProvider, ProviderExecutionContext } from '../provider.js';
import type { ModelInfo } from '../schemas/models.js';
import type { ProviderHealth } from '../schemas/health.js';
import type { UnifiedAiRequest, UnifiedAiResponse } from '../schemas/chat.js';
import type {
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from '../schemas/embeddings.js';
import type { UnifiedStreamEvent } from '../schemas/stream.js';
import type { UsageKind, UsageObservationV1 } from '../schemas/usage.js';

/**
 * Callback fired after a successful chat or embedding round-trip
 * with the provider's reported token counts. Consumers use this to
 * append a UsageRecord to their JSONL sink (llamactl's
 * @nova/mcp-shared.appendUsageBackground) without the adapter
 * needing to know what storage the consumer uses.
 *
 * The record is minimal on purpose — the adapter has no opinion on
 * request_id, route, or user tags. Callers enrich before writing.
 */
export interface OpenAICompatUsageSnapshot {
  provider: string;
  model: string;
  kind: UsageKind;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
}

export type OpenAICompatOnUsage = (snapshot: OpenAICompatUsageSnapshot) => void;

/**
 * Provenance-honest counterpart to `OpenAICompatUsageSnapshot`.
 * `observation` carries only the counts the upstream actually
 * reported (`source: 'observed'`, missing components absent), or
 * `source: 'unknown'` when the upstream returned no usage block —
 * never a zero-filled stand-in. Consumers building `UsageRecordV2`
 * rows can copy `observation` verbatim.
 */
export interface OpenAICompatUsageObservation {
  provider: string;
  model: string;
  kind: UsageKind;
  latency_ms: number;
  observation: UsageObservationV1;
  request_id?: string;
  attempt_id?: string;
}

export type OpenAICompatOnUsageObservation = (
  snapshot: OpenAICompatUsageObservation,
) => void;

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
  /**
   * Endpoint to probe in `healthCheck`. Defaults to `/models` (OpenAI
   * convention — a 200 means the API key + service are alive).
   * Self-hosted gateways often expose a cheaper `/health` that doesn't
   * require auth; point here for those cases. Must include the leading
   * slash; combined with `baseUrl` verbatim.
   */
  healthPath?: string;
  /**
   * Optional callback fired after each successful chat / embedding
   * call. Lets consumers (llamactl, embersynth) append a usage
   * record to their JSONL sink without the adapter caring about
   * storage. Exceptions thrown from the callback are swallowed so a
   * misbehaving logger can't bleed into the response path.
   *
   * For streaming, fires when the final `stream: true` SSE frame
   * carries a `usage` block (operators must pass
   * `stream_options: { include_usage: true }` to get one from
   * OpenAI-style backends). Absent usage → callback not fired.
   */
  onUsage?: OpenAICompatOnUsage;
  /**
   * Fires after every successful chat / embedding round-trip and at
   * natural stream end — including when the upstream sent no usage
   * data (`observation.source === 'unknown'`). Unlike `onUsage`,
   * missing component counts stay absent rather than zero-filled.
   * Exceptions are swallowed like `onUsage`.
   */
  onUsageObservation?: OpenAICompatOnUsageObservation;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Merge the caller's signal with a deadline-derived timeout. An
 * already-past deadline yields a pre-aborted signal so fetch rejects
 * before the request leaves.
 */
function contextSignal(context?: ProviderExecutionContext): AbortSignal | undefined {
  if (!context) return undefined;
  const signals: AbortSignal[] = [];
  if (context.signal) signals.push(context.signal);
  if (context.deadline !== undefined) {
    const ms = context.deadline - Date.now();
    signals.push(ms <= 0 ? AbortSignal.abort() : AbortSignal.timeout(ms));
  }
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

/**
 * Translate a raw wire `usage` block into a provenance-tagged
 * observation. Only fields the upstream actually sent are carried;
 * absent usage (or absent components) never become 0.
 */
function toObservation(
  usage: WireUsage | undefined,
  upstreamRequestId?: string,
): UsageObservationV1 {
  const id = upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {};
  if (!usage) return { source: 'unknown', ...id };
  return {
    source: 'observed',
    ...(typeof usage.prompt_tokens === 'number'
      ? { input_tokens: usage.prompt_tokens }
      : {}),
    ...(typeof usage.completion_tokens === 'number'
      ? { output_tokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === 'number'
      ? { total_tokens: usage.total_tokens }
      : {}),
    ...id,
  };
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

  function fireUsage(snapshot: OpenAICompatUsageSnapshot): void {
    if (!opts.onUsage) return;
    try {
      opts.onUsage(snapshot);
    } catch {
      // Swallow — usage logging is fire-and-forget; the response
      // path must never fail because a sink errored.
    }
  }

  function fireObservation(snapshot: OpenAICompatUsageObservation): void {
    if (!opts.onUsageObservation) return;
    try {
      opts.onUsageObservation(snapshot);
    } catch {
      // Same fire-and-forget contract as fireUsage.
    }
  }

  function contextIdentity(context?: ProviderExecutionContext): {
    request_id?: string;
    attempt_id?: string;
  } {
    return {
      ...(context?.requestId ? { request_id: context.requestId } : {}),
      ...(context?.attemptId ? { attempt_id: context.attemptId } : {}),
    };
  }

  return {
    name: opts.name,
    displayName: opts.displayName ?? opts.name,

    async createResponse(
      request: UnifiedAiRequest,
      context?: ProviderExecutionContext,
    ): Promise<UnifiedAiResponse> {
      const startedAt = Date.now();
      // Strip nova-only fields before sending upstream.
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const signal = contextSignal(context);
      const res = await call('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: false }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${opts.name} ${res.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedAiResponse;
      const latencyMs = Date.now() - startedAt;
      if (raw.usage) {
        fireUsage({
          provider: opts.name,
          model: raw.model ?? request.model,
          kind: 'chat',
          prompt_tokens: raw.usage.prompt_tokens,
          completion_tokens: raw.usage.completion_tokens,
          total_tokens: raw.usage.total_tokens,
          latency_ms: latencyMs,
        });
      }
      fireObservation({
        provider: opts.name,
        model: raw.model ?? request.model,
        kind: 'chat',
        latency_ms: latencyMs,
        observation: toObservation(raw.usage, raw.id || undefined),
        ...contextIdentity(context),
      });
      return {
        ...raw,
        latencyMs,
        provider: opts.name,
      };
    },

    async *streamResponse(
      request: UnifiedAiRequest,
      signal?: AbortSignal,
    ): AsyncIterable<UnifiedStreamEvent> {
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}), stream: true };
      // Internal controller so a consumer `break`/`return` tears the
      // upstream request down — cancelling the body reader alone
      // doesn't propagate to the server.
      const teardown = new AbortController();
      const fetchSignal = signal
        ? AbortSignal.any([signal, teardown.signal])
        : teardown.signal;
      const startedAt = Date.now();
      const res = await call('/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: fetchSignal,
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
        teardown.abort();
        return;
      }
      if (!res.body) {
        fireObservation({
          provider: opts.name,
          model: request.model,
          kind: 'chat',
          latency_ms: Date.now() - startedAt,
          observation: { source: 'unknown' },
        });
        yield { type: 'done', finish_reason: 'stop', completion: 'eof' };
        teardown.abort();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      type DoneEvent = Extract<UnifiedStreamEvent, { type: 'done' }>;
      let lastFinish: DoneEvent = { type: 'done', finish_reason: 'stop' };
      let sawFinish = false;
      let usageSeen = false;
      let lastModel = request.model;
      let lastId = '';
      try {
        while (true) {
          if (fetchSignal.aborted) break;
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
              if (!usageSeen) {
                fireObservation({
                  provider: opts.name,
                  model: lastModel,
                  kind: 'chat',
                  latency_ms: Date.now() - startedAt,
                  observation: toObservation(undefined, lastId || undefined),
                });
              }
              yield { ...lastFinish, completion: 'upstream' };
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
                  delta?: {
                    role?: 'assistant' | 'tool';
                    content?: string | null;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      type?: 'function';
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                };
              };
              if (chunk.model) lastModel = chunk.model;
              if (chunk.id) lastId = chunk.id;
              // Usage frame — OpenAI emits this as the penultimate
              // chunk when the client passes `stream_options:
              // { include_usage: true }`. Fire onUsage + fall through
              // (there may be a trailing [DONE] after).
              if (chunk.usage) {
                usageSeen = true;
                fireUsage({
                  provider: opts.name,
                  model: lastModel,
                  kind: 'chat',
                  prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                  completion_tokens: chunk.usage.completion_tokens ?? 0,
                  total_tokens: chunk.usage.total_tokens ?? 0,
                  latency_ms: Date.now() - startedAt,
                });
                fireObservation({
                  provider: opts.name,
                  model: lastModel,
                  kind: 'chat',
                  latency_ms: Date.now() - startedAt,
                  observation: toObservation(chunk.usage, chunk.id ?? (lastId || undefined)),
                });
              }
              if (!chunk.choices || chunk.choices.length === 0) continue;
              const finish = chunk.choices[0]?.finish_reason;
              if (finish) {
                sawFinish = true;
                lastFinish = {
                  type: 'done',
                  finish_reason: finish as DoneEvent['finish_reason'],
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
                      ...(c.delta?.tool_calls ? { tool_calls: c.delta.tool_calls } : {}),
                    },
                    ...(c.finish_reason !== undefined
                      ? { finish_reason: c.finish_reason as DoneEvent['finish_reason'] }
                      : {}),
                  })),
                },
              };
            } catch {
              // Ignore non-JSON data lines; some providers emit keep-alives.
            }
          }
        }
      } finally {
        try {
          await reader.cancel();
          reader.releaseLock();
        } catch {
          // best-effort teardown
        }
        teardown.abort();
      }
      if (!usageSeen) {
        fireObservation({
          provider: opts.name,
          model: lastModel,
          kind: 'chat',
          latency_ms: Date.now() - startedAt,
          observation: toObservation(undefined, lastId || undefined),
        });
      }
      yield {
        ...lastFinish,
        completion: sawFinish ? 'upstream' : 'eof',
      };
    },

    async createEmbeddings(
      request: UnifiedEmbeddingRequest,
      context?: ProviderExecutionContext,
    ): Promise<UnifiedEmbeddingResponse> {
      const startedAt = Date.now();
      const { providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const signal = contextSignal(context);
      const res = await call('/embeddings', {
        method: 'POST',
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${opts.name} ${res.status}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedEmbeddingResponse & {
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const latencyMs = Date.now() - startedAt;
      if (raw.usage) {
        fireUsage({
          provider: opts.name,
          model: raw.model ?? request.model,
          kind: 'embedding',
          prompt_tokens: raw.usage.prompt_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: raw.usage.total_tokens ?? raw.usage.prompt_tokens ?? 0,
          latency_ms: latencyMs,
        });
      }
      fireObservation({
        provider: opts.name,
        model: raw.model ?? request.model,
        kind: 'embedding',
        latency_ms: latencyMs,
        observation: toObservation(raw.usage, undefined),
        ...contextIdentity(context),
      });
      return {
        ...raw,
        latencyMs,
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
      const probePath = opts.healthPath ?? '/models';
      try {
        const res = await call(probePath, { method: 'GET' });
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
