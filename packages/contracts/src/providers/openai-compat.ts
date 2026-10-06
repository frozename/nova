import type { ReadableStreamDefaultReader } from "node:stream/web";

import { z } from "zod";

import type { AiProvider, ProviderExecutionContext } from "../provider.js";
import type { UnifiedAiRequest, UnifiedAiResponse } from "../schemas/chat.js";
import type { UnifiedEmbeddingRequest, UnifiedEmbeddingResponse } from "../schemas/embeddings.js";
import type { ProviderHealth } from "../schemas/health.js";
import type { ModelInfo } from "../schemas/models.js";
import type { UnifiedStreamEvent } from "../schemas/stream.js";
import type { UsageKind, UsageObservationV1 } from "../schemas/usage.js";

import { FinishReasonSchema } from "../schemas/chat.js";

/**
 * Callback fired after a successful chat or embedding round-trip
 * with the provider's reported token counts. Consumers use this to
 * append a UsageRecord to their JSONL sink (llamactl's
 * @novaproto/mcp-shared.appendUsageBackground) without the adapter
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

export type OpenAICompatOnUsageObservation = (snapshot: OpenAICompatUsageObservation) => void;

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
   * For streaming, fires once per `usage` SSE frame (operators must
   * pass `stream_options: { include_usage: true }` to get them from
   * OpenAI-style backends) — providers that send cumulative usage on
   * every chunk therefore produce one call per frame. Absent usage →
   * callback not fired. The single-record-per-attempt contract lives
   * on `onUsageObservation`.
   */
  onUsage?: OpenAICompatOnUsage;
  /**
   * Exactly one record per call that reached the upstream.
   * `createResponse` / `createEmbeddings` fire once after an OK
   * response; `streamResponse` fires once per attempt that received
   * an OK HTTP response, on every termination path — upstream
   * `[DONE]`, EOF, an SSE error frame, consumer `break`/`return`, or
   * caller abort (the upstream may have performed billable work even
   * when the stream was cut short). On stream paths that emit a
   * terminal event, the observation fires strictly after that
   * `done`/`error` event has been yielded — the consumer always
   * sees the terminal event first; on paths with no terminal event
   * (consumer break, caller abort) it fires from the same
   * single-shot cleanup. The record carries the LAST usage frame
   * seen that held at least one numeric count (cumulative
   * last-wins; a count-less usage frame never erases an earlier
   * frame), or `observation.source === 'unknown'` when none
   * arrived. Unlike `onUsage`, missing component counts stay
   * absent rather than zero-filled. Exceptions are swallowed like
   * `onUsage`.
   */
  onUsageObservation?: OpenAICompatOnUsageObservation;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
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
    signals.push(
      ms <= 0
        ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
        : AbortSignal.timeout(ms),
    );
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
 * Whether a wire usage block carries at least one numeric count —
 * the bar for the stream observation's last-wins update. A
 * count-less usage frame (`usage: {}`) never displaces an earlier
 * observed frame.
 */
function hasNumericUsageCount(usage: WireUsage): boolean {
  return (
    typeof usage.prompt_tokens === "number" ||
    typeof usage.completion_tokens === "number" ||
    typeof usage.total_tokens === "number"
  );
}

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
  if (!usage) return { source: "unknown", ...id };
  if (!hasNumericUsageCount(usage)) return { source: "unknown", ...id };
  return {
    source: "observed",
    ...(typeof usage.prompt_tokens === "number" ? { input_tokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { output_tokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number" ? { total_tokens: usage.total_tokens } : {}),
    ...id,
  };
}

/**
 * Rate-limit and server-overload style codes are worth retrying;
 * everything else (auth, quota, validation) is not. Works on both
 * OpenAI `code` values ('rate_limit_exceeded', 'server_error') and
 * `type` values ('overloaded_error'), plus HTTP status numbers.
 */
function isRetryableUpstreamCode(code: string): boolean {
  const c = code.trim().toLowerCase();
  if (["429", "500", "502", "503", "504", "529"].includes(c)) return true;
  return (
    c.includes("rate_limit") ||
    c.includes("ratelimit") ||
    c.includes("overload") ||
    c.includes("server_error") ||
    c.includes("internal_error") ||
    c.includes("unavailable") ||
    c.includes("timeout")
  );
}

/**
 * Whether a wire `error` member actually describes an upstream
 * error: a non-empty string, or a non-array object carrying at
 * least one of `message`, `type`, or `code`. Falsy and empty
 * placeholders (`false`, `""`, `0`, `[]`, `{}`) are ignored — some
 * upstreams emit them on healthy frames.
 */
function isWireError(err: unknown): boolean {
  if (typeof err === "string") return err.length > 0;
  if (typeof err !== "object" || err === null || Array.isArray(err)) {
    return false;
  }
  const e = err as { message?: unknown; type?: unknown; code?: unknown };
  return e.message !== undefined || e.type !== undefined || e.code !== undefined;
}

function formatWireErrorCode(code: unknown): string | undefined {
  if (typeof code === "string") return code;
  if (
    typeof code === "number" ||
    typeof code === "boolean" ||
    typeof code === "bigint" ||
    typeof code === "symbol"
  )
    return String(code);
  return code === null ? undefined : JSON.stringify(code);
}

/**
 * Translate a mid-stream `{"error": …}` payload member into the
 * unified error-event shape. OpenAI-style upstreams deliver errors
 * either as an object ({message, type, code}) or a bare string.
 */
function wireErrorToEvent(err: unknown): {
  message: string;
  code?: string;
  retryable: boolean;
} {
  let message: string;
  let rawCode: unknown;
  if (typeof err === "string") {
    message = err;
  } else if (err !== null && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; type?: unknown };
    message = typeof e.message === "string" ? e.message : JSON.stringify(err);
    rawCode = e.code ?? e.type;
  } else {
    message = String(err);
  }
  const code = formatWireErrorCode(rawCode);
  return {
    message,
    ...(code !== undefined ? { code } : {}),
    // Retryability is a property of the raw wire value: only primitive
    // string/number codes go through the keyword match. A structured
    // code rendered to JSON must never turn retryable.
    retryable:
      (typeof rawCode === "string" || typeof rawCode === "number") &&
      code !== undefined &&
      isRetryableUpstreamCode(code),
  };
}

/**
 * Merge the adapter's base headers (content-type, auth, extraHeaders) with a
 * per-request `init.headers`, letting the caller's headers win on a
 * case-insensitive collision. Routing both sides through `Headers` keeps the
 * merge correct regardless of whether the caller passed a plain record, a
 * `Headers` instance, or a `[name, value]` tuple array — the three HeadersInit
 * shapes. Exported for direct testing; the `AiProvider` surface is unchanged.
 *
 * `initHeaders` is typed as `RequestInit["headers"]` (the node-provided type)
 * rather than the DOM-only `HeadersInit`, which is absent from this project's
 * `ES2023` lib and degrades to `any` under the strict gate.
 */
export function mergeRequestHeaders(
  baseHeaders: Record<string, string>,
  initHeaders: RequestInit["headers"],
): Headers {
  const merged = new Headers(baseHeaders);
  if (initHeaders) {
    for (const [k, v] of new Headers(initHeaders).entries()) {
      merged.set(k, v);
    }
  }
  return merged;
}

/** Finish-reason variant of {@link UnifiedStreamEvent}'s `done` arm. */
type StreamFinishReason = Extract<UnifiedStreamEvent, { type: "done" }>["finish_reason"];

/**
 * Map an upstream finish_reason string onto the canonical
 * {@link FinishReasonSchema} enum, self-auditing against the schema's own
 * options so a new variant can never silently pass through as an unchecked
 * cast. Unknown / absent reasons collapse to "stop" (the safe terminal).
 */
function mapFinishReason(finish: string | null | undefined): StreamFinishReason {
  return (FinishReasonSchema.options as readonly string[]).includes(finish ?? "")
    ? (finish as StreamFinishReason)
    : "stop";
}

/**
 * Validation envelope for the non-streaming `.json()` boundary. The
 * id, model name and token-usage block are the only fields the adapter
 * reads for telemetry; everything else passes through untouched so the
 * returned body keeps its full shape. A parse failure means the usage
 * snapshot is skipped (malformed-response path) rather than fired with
 * garbage numbers.
 */
const UsageBlockSchema = z.looseObject({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

function pickWireUsage(usage: z.infer<typeof UsageBlockSchema> | undefined): WireUsage | undefined {
  if (!usage) return undefined;
  return {
    ...(typeof usage.prompt_tokens === "number" ? { prompt_tokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { completion_tokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number" ? { total_tokens: usage.total_tokens } : {}),
  };
}

const ResponseEnvelopeSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  usage: UsageBlockSchema.optional(),
});

// eslint-disable-next-line max-lines-per-function -- The provider methods share request and telemetry closures for one configured upstream.
export function createOpenAICompatProvider(opts: OpenAICompatOptions): AiProvider {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = trimTrailingSlash(opts.baseUrl);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  });

  async function call(path: string, init: RequestInit): Promise<Response> {
    const merged = mergeRequestHeaders(headers(), init.headers);
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
      const res = await call("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ ...body, stream: false }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`);
      }
      const parsedBody: unknown = await res.json();
      const parsed = ResponseEnvelopeSchema.safeParse(parsedBody);
      const latencyMs = Date.now() - startedAt;
      // The envelope parse feeds telemetry only — id, model and the usage
      // block the two callbacks read. The upstream body is returned to the
      // caller as sent, malformed envelope or not; the caller's response
      // schema is the next gate.
      const raw = parsedBody as UnifiedAiResponse;
      const envelope = parsed.success ? parsed.data : undefined;
      const usage = envelope?.usage;
      const model = envelope?.model ?? request.model;
      if (
        usage?.prompt_tokens !== undefined &&
        usage.completion_tokens !== undefined &&
        usage.total_tokens !== undefined
      ) {
        fireUsage({
          provider: opts.name,
          model,
          kind: "chat",
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          latency_ms: latencyMs,
        });
      }
      fireObservation({
        provider: opts.name,
        model,
        kind: "chat",
        latency_ms: latencyMs,
        observation: toObservation(pickWireUsage(usage), envelope?.id),
        ...contextIdentity(context),
      });
      return {
        ...raw,
        ...(Array.isArray(raw.choices)
          ? {
              choices: raw.choices.map((choice) => ({
                ...choice,
                ...(typeof choice.finish_reason === "string"
                  ? { finish_reason: mapFinishReason(choice.finish_reason) }
                  : {}),
              })),
            }
          : {}),
        latencyMs,
        provider: opts.name,
      };
    },

    // eslint-disable-next-line max-lines-per-function, sonarjs/cognitive-complexity -- The SSE loop keeps ordered yields, caller abort checks, and cleanup in one generator scope.
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
      const fetchSignal = signal ? AbortSignal.any([signal, teardown.signal]) : teardown.signal;
      // A caller abort throws no matter when it lands — the caller's
      // own signal (not the merged fetch signal) is checked before
      // every read and around every yield, so an abort delivered
      // while the generator sits at a yield throws the signal's
      // reason instead of letting a buffered event (or done) through.
      const throwIfCallerAborted = (): void => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
        }
      };
      const startedAt = Date.now();
      const res = await call("/chat/completions", {
        method: "POST",
        body: JSON.stringify(body),
        signal: fetchSignal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        try {
          throwIfCallerAborted();
          yield {
            type: "error",
            error: {
              message: `${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`,
              code: String(res.status),
              retryable: res.status >= 500 || res.status === 429,
            },
          };
          throwIfCallerAborted();
        } finally {
          teardown.abort();
        }
        return;
      }
      type DoneEvent = Extract<UnifiedStreamEvent, { type: "done" }>;
      let lastFinish: DoneEvent = { type: "done", finish_reason: "stop" };
      const completionState = { sawFinish: false };
      let lastUsage: WireUsage | undefined;
      let lastModel = request.model;
      let lastId = "";
      // Exactly one observation per attempt that reached the upstream,
      // fired from the cleanup path so every termination — [DONE],
      // EOF, error frame, consumer break, caller abort — produces
      // exactly one record carrying the last usage frame that held a
      // numeric count. On paths that emit a terminal event it fires
      // strictly after that event was yielded.
      let observationFired = false;
      const fireStreamObservation = (): void => {
        if (observationFired) return;
        observationFired = true;
        fireObservation({
          provider: opts.name,
          model: lastModel,
          kind: "chat",
          latency_ms: Date.now() - startedAt,
          observation: toObservation(lastUsage, lastId || undefined),
        });
      };
      if (!res.body) {
        try {
          throwIfCallerAborted();
          yield { type: "done", finish_reason: "stop", completion: "eof" };
          throwIfCallerAborted();
        } finally {
          fireStreamObservation();
          teardown.abort();
        }
        return;
      }
      const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = "";
      type FrameOutcome = {
        events: UnifiedStreamEvent[];
        terminal?: "done" | "error";
      };
      const handlePayload = (payload: string): FrameOutcome => {
        if (payload === "[DONE]") return { events: [], terminal: "done" };
        try {
          const chunk = JSON.parse(payload) as {
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
            usage?: WireUsage;
            error?: unknown;
          };
          if (chunk.model) lastModel = chunk.model;
          if (chunk.id) lastId = chunk.id;
          const events: UnifiedStreamEvent[] = [];
          // Usage frame — OpenAI emits this as the penultimate chunk
          // when the client passes `stream_options: { include_usage:
          // true }`. Captured before the error check so a frame
          // carrying both still feeds the observation. Legacy onUsage
          // fires per frame; the observation keeps only the last
          // (cumulative) frame with at least one numeric count for
          // the single record fired at cleanup.
          if (chunk.usage) {
            if (hasNumericUsageCount(chunk.usage)) lastUsage = chunk.usage;
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
          if (chunk.choices && chunk.choices.length > 0) {
            const finish = chunk.choices[0]?.finish_reason;
            if (finish) {
              completionState.sawFinish = true;
              lastFinish = {
                type: "done",
                finish_reason: mapFinishReason(finish),
              };
            }
            events.push({
              type: "chunk",
              chunk: {
                id: chunk.id ?? "",
                object: "chat.completion.chunk",
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
                    ? {
                        finish_reason:
                          c.finish_reason === null ? null : mapFinishReason(c.finish_reason),
                      }
                    : {}),
                })),
              },
            });
          }
          // An upstream error delivered as a data frame is terminal —
          // it is yielded after any content delta the same frame
          // carried, then the stream ends with no done event,
          // mirroring the !res.ok path.
          if (isWireError(chunk.error)) {
            events.push({ type: "error", error: wireErrorToEvent(chunk.error) });
            return { events, terminal: "error" };
          }
          return { events };
        } catch {
          // Ignore non-JSON data lines; some providers emit keep-alives.
          return { events: [] };
        }
      };
      const handleFrame = (frame: string): FrameOutcome => {
        const f = frame.trim();
        if (!f.startsWith("data:")) return { events: [] };
        return handlePayload(f.slice(5).trim());
      };
      try {
        let eof = false;
        while (!eof) {
          throwIfCallerAborted();
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (err) {
            // An abort delivered mid-read rejects the reader — surface
            // the caller's reason rather than the transport's.
            if (signal?.aborted) throw signal.reason ?? err;
            throw err;
          }
          eof = read.done;
          // On EOF the decoder is final-flushed (no `stream` flag) so
          // a split multi-byte sequence isn't dropped; the residual
          // buffer is then processed line-wise below.
          buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
          // OpenAI SSE frames are separated by blank lines; each frame
          // is a `data: {...}` line (plus `event:` in some dialects).
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const outcome = handleFrame(frame);
            throwIfCallerAborted();
            for (const ev of outcome.events) {
              yield ev;
              throwIfCallerAborted();
            }
            if (outcome.terminal === "done") {
              yield { ...lastFinish, completion: "upstream" };
              throwIfCallerAborted();
              return;
            }
            if (outcome.terminal === "error") return;
          }
          if (eof && buffer.trim().length > 0) {
            // The transport closed without a final blank line — any
            // complete `data:` line still buffered is a real frame
            // (e.g. a trailing `data: [DONE]`).
            const residual = buffer;
            buffer = "";
            for (const line of residual.split("\n")) {
              const outcome = handleFrame(line);
              throwIfCallerAborted();
              for (const ev of outcome.events) {
                yield ev;
                throwIfCallerAborted();
              }
              if (outcome.terminal === "done") {
                yield { ...lastFinish, completion: "upstream" };
                throwIfCallerAborted();
                return;
              }
              if (outcome.terminal === "error") return;
            }
          }
        }
        throwIfCallerAborted();
        yield {
          ...lastFinish,
          completion: completionState.sawFinish ? "upstream" : "eof",
        };
        throwIfCallerAborted();
      } finally {
        fireStreamObservation();
        try {
          await reader.cancel();
          reader.releaseLock();
        } catch {
          // best-effort teardown
        }
        teardown.abort();
      }
    },

    async createEmbeddings(
      request: UnifiedEmbeddingRequest,
      context?: ProviderExecutionContext,
    ): Promise<UnifiedEmbeddingResponse> {
      const startedAt = Date.now();
      const { providerOptions: _p, ...wireBody } = request;
      const body = { ...wireBody, ...(_p ?? {}) };
      const signal = contextSignal(context);
      const res = await call("/embeddings", {
        method: "POST",
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${opts.name} ${String(res.status)}: ${text.slice(0, 500)}`);
      }
      const parsedBody: unknown = await res.json();
      const parsed = ResponseEnvelopeSchema.safeParse(parsedBody);
      const latencyMs = Date.now() - startedAt;
      // Same telemetry-only envelope parse as createResponse — the body is
      // returned as sent even when the envelope fails to parse.
      const raw = parsedBody as UnifiedEmbeddingResponse;
      const envelope = parsed.success ? parsed.data : undefined;
      const usage = envelope?.usage;
      const model = envelope?.model ?? request.model;
      if (usage) {
        fireUsage({
          provider: opts.name,
          model,
          kind: "embedding",
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: 0,
          total_tokens: usage.total_tokens ?? usage.prompt_tokens ?? 0,
          latency_ms: latencyMs,
        });
      }
      fireObservation({
        provider: opts.name,
        model,
        kind: "embedding",
        latency_ms: latencyMs,
        observation: toObservation(pickWireUsage(usage), undefined),
        ...contextIdentity(context),
      });
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
        data?: { id?: string | number; created?: number; owned_by?: string }[];
      };
      const now = Math.floor(Date.now() / 1000);
      return (raw.data ?? []).map((m) => ({
        id: String(m.id ?? ""),
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
