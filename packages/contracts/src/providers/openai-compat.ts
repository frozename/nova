import type { AiProvider } from "../provider.js";
import type { UnifiedAiRequest, UnifiedAiResponse } from "../schemas/chat.js";
import type { UnifiedEmbeddingRequest, UnifiedEmbeddingResponse } from "../schemas/embeddings.js";
import type { ProviderHealth } from "../schemas/health.js";
import type { ModelInfo } from "../schemas/models.js";
import type { UnifiedStreamEvent } from "../schemas/stream.js";
import type { UsageKind } from "../schemas/usage.js";

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
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Finish-reason variant of {@link UnifiedStreamEvent}'s `done` arm. */
type StreamFinishReason = UnifiedStreamEvent extends { type: "done"; finish_reason: infer F }
  ? F
  : never;

/** Raw OpenAI SSE chunk shape (a relaxed view of the wire payload). */
interface WireStreamChunk {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  choices?: {
    index?: number;
    delta?: {
      role?: "assistant" | "tool";
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Map a parsed OpenAI SSE chunk (with at least one choice) into the
 * unified `chunk` stream event. Pure — no side effects — so the
 * generator stays focused on transport/buffering control flow.
 */
function toChunkEvent(
  chunk: WireStreamChunk & { choices: NonNullable<WireStreamChunk["choices"]> },
  fallbackModel: string,
): UnifiedStreamEvent {
  return {
    type: "chunk",
    chunk: {
      id: chunk.id ?? "",
      object: "chat.completion.chunk",
      model: chunk.model ?? fallbackModel,
      created: chunk.created ?? Math.floor(Date.now() / 1000),
      choices: chunk.choices.map((c) => ({
        index: c.index ?? 0,
        delta: {
          ...(c.delta?.role ? { role: c.delta.role } : {}),
          ...(c.delta?.content !== undefined ? { content: c.delta.content } : {}),
          ...(c.delta?.tool_calls ? { tool_calls: c.delta.tool_calls } : {}),
        },
        ...(c.finish_reason !== undefined
          ? { finish_reason: c.finish_reason as StreamFinishReason }
          : {}),
      })),
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- factory returns the full 5-method AiProvider surface (createResponse/streamResponse/createEmbeddings/listModels/healthCheck) as one closure over `opts`; the length is the sum of those method bodies, not a single oversized function, and splitting the closure would scatter the shared `call`/`fireUsage`/`headers` helpers.
export function createOpenAICompatProvider(opts: OpenAICompatOptions): AiProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = trimTrailingSlash(opts.baseUrl);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  });

  async function call(path: string, init: RequestInit): Promise<Response> {
    const merged = new Headers(headers());
    if (init.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) {
        merged.set(k, v);
      }
    }
    return await fetchImpl(`${base}${path}`, {
      ...init,
      headers: merged,
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

  return {
    name: opts.name,
    displayName: opts.displayName ?? opts.name,

    async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
      const startedAt = Date.now();
      // Strip nova-only fields before sending upstream.
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const res = await call("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedAiResponse;
      const latencyMs = Date.now() - startedAt;
      if (raw.usage) {
        fireUsage({
          provider: opts.name,
          model: (raw as { model?: string }).model ?? request.model,
          kind: "chat",
          prompt_tokens: raw.usage.prompt_tokens,
          completion_tokens: raw.usage.completion_tokens,
          total_tokens: raw.usage.total_tokens,
          latency_ms: latencyMs,
        });
      }
      return {
        ...raw,
        latencyMs,
        provider: opts.name,
      };
    },

    // eslint-disable-next-line sonarjs/cognitive-complexity -- irreducible SSE-decode control flow: outer read loop + abort/done checks + inner frame-split (`\n\n`) + data:/[DONE] sentinel guards + usage-frame and finish-frame branches must share the same mutable buffer/lastFinish/lastModel and retain the ability to `return` (on [DONE]) from inside the nested loops; extracting them would require threading that state and an early-terminate signal through a helper, which is more error-prone on this most-consumed adapter than the flat reader.
    async *streamResponse(
      request: UnifiedAiRequest,
      signal?: AbortSignal,
    ): AsyncIterable<UnifiedStreamEvent> {
      const { capabilities: _c, providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}), stream: true };
      const res = await call("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        yield {
          type: "error",
          error: {
            message: `${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`,
            code: String(res.status),
            retryable: res.status >= 500 || res.status === 429,
          },
        };
        return;
      }
      if (!res.body) {
        yield { type: "done", finish_reason: "stop" };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const startedAt = Date.now();
      let buffer = "";
      let lastFinish: UnifiedStreamEvent = { type: "done", finish_reason: "stop" };
      let lastModel = request.model;
      for (;;) {
        if (signal?.aborted) break;
        const { value, done } = (await reader.read()) as {
          value?: Uint8Array;
          done: boolean;
        };
        if (done || !value) break;
        buffer += decoder.decode(value, { stream: true });
        // OpenAI SSE frames are separated by blank lines; each frame
        // is a `data: {...}` line (plus `event:` in some dialects).
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 2);
          if (!frame.startsWith("data:")) continue;
          const payload = frame.slice(5).trim();
          if (payload === "[DONE]") {
            yield lastFinish;
            return;
          }
          try {
            const chunk = JSON.parse(payload) as WireStreamChunk;
            if (chunk.model) lastModel = chunk.model;
            // Usage frame — OpenAI emits this as the penultimate
            // chunk when the client passes `stream_options:
            // { include_usage: true }`. Fire onUsage + fall through
            // (there may be a trailing [DONE] after).
            if (chunk.usage) {
              fireUsage({
                provider: opts.name,
                model: lastModel,
                kind: "chat",
                prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                completion_tokens: chunk.usage.completion_tokens ?? 0,
                total_tokens: chunk.usage.total_tokens ?? 0,
                latency_ms: Date.now() - startedAt,
              });
            }
            if (!chunk.choices) continue;
            const finish = chunk.choices[0]?.finish_reason;
            if (finish) {
              lastFinish = { type: "done", finish_reason: finish as StreamFinishReason };
            }
            yield toChunkEvent({ ...chunk, choices: chunk.choices }, request.model);
          } catch {
            // Ignore non-JSON data lines; some providers emit keep-alives.
          }
        }
      }
      yield lastFinish;
    },

    async createEmbeddings(request: UnifiedEmbeddingRequest): Promise<UnifiedEmbeddingResponse> {
      const startedAt = Date.now();
      const { providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const res = await call("/embeddings", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as UnifiedEmbeddingResponse;
      const latencyMs = Date.now() - startedAt;
      const usage = (raw as { usage?: { prompt_tokens?: number; total_tokens?: number } }).usage;
      if (usage) {
        fireUsage({
          provider: opts.name,
          model: (raw as { model?: string }).model ?? request.model,
          kind: "embedding",
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: usage.total_tokens ?? usage.prompt_tokens ?? 0,
          latency_ms: latencyMs,
        });
      }
      return {
        ...raw,
        latencyMs,
        provider: opts.name,
      };
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await call("/models", { method: "GET" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${opts.name} /models ${String(res.status)}: ${text.slice(0, 500)}`);
      }
      const raw = (await res.json()) as {
        data?: { id?: string; created?: number; owned_by?: string }[];
      };
      const now = Math.floor(Date.now() / 1000);
      return (raw.data ?? []).map((m) => ({
        id: m.id ?? "",
        object: "model" as const,
        created: m.created ?? now,
        owned_by: m.owned_by ?? opts.name,
        capabilities: ["chat" as const],
      }));
    },

    async healthCheck(): Promise<ProviderHealth> {
      const startedAt = Date.now();
      const probePath = opts.healthPath ?? "/models";
      try {
        const res = await call(probePath, { method: "GET" });
        const latencyMs = Date.now() - startedAt;
        if (!res.ok) {
          return {
            state: res.status >= 500 ? "unhealthy" : "degraded",
            lastChecked: new Date().toISOString(),
            latencyMs,
            error: `HTTP ${String(res.status)}`,
          };
        }
        return {
          state: "healthy",
          lastChecked: new Date().toISOString(),
          latencyMs,
        };
      } catch (err) {
        return {
          state: "unhealthy",
          lastChecked: new Date().toISOString(),
          error: (err as Error).message,
        };
      }
    },
  };
}
