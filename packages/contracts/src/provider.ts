import type { UnifiedAiRequest, UnifiedAiResponse } from './schemas/chat.js';
import type { UnifiedStreamEvent } from './schemas/stream.js';
import type { UnifiedEmbeddingRequest, UnifiedEmbeddingResponse } from './schemas/embeddings.js';
import type { ModelInfo } from './schemas/models.js';
import type { ProviderHealth } from './schemas/health.js';
import type {
  DeleteRequest,
  DeleteResponse,
  ListCollectionsResponse,
  SearchRequest,
  SearchResponse,
  StoreRequest,
  StoreResponse,
} from './schemas/retrieval.js';

/**
 * Canonical AI-provider adapter. Every backend — local llama.cpp
 * agent, OpenAI, Anthropic, Together, groq, a peer llamactl via its
 * `/v1` gateway, a sirius gateway instance — implements this. Routing
 * layers (llamactl's dispatcher, sirius's fallback chains,
 * embersynth's capability router) compose providers; no layer cares
 * how a given provider talks to its upstream.
 *
 * Streaming is modeled as an `AsyncIterable<UnifiedStreamEvent>`
 * rather than a callback pair so cancellation is the consumer's
 * `break`/`return` — no separate `onError`/`onComplete` wiring.
 * Adapters that can't stream natively (rare, since OpenAI-style
 * providers all support SSE) may fall back to a single synthetic
 * `{ type: 'chunk', ... }` with `finish_reason` set.
 *
 * Optional methods (`createEmbeddings`, `listModels`, `healthCheck`)
 * let minimal adapters ship without standing up every surface; the
 * orchestrator treats `undefined` as "this provider doesn't do that"
 * and skips it.
 */
export interface AiProvider {
  /** Stable identifier — lowercase, filesystem-safe (e.g. `openai`). */
  readonly name: string;

  /** Human display name (e.g. `"OpenAI"`, `"Local llama.cpp"`). */
  readonly displayName?: string;

  createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse>;

  streamResponse?(
    request: UnifiedAiRequest,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamEvent>;

  createEmbeddings?(
    request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse>;

  listModels?(): Promise<ModelInfo[]>;

  healthCheck?(): Promise<ProviderHealth>;
}

/**
 * Retrieval (RAG) provider adapter. Nodes carrying a `rag` binding in
 * llamactl's kubeconfig resolve to one of these at call time; ops-chat,
 * the Electron Knowledge module, and future Chat/Pipelines consumers
 * all talk to the interface rather than any specific backend. Score
 * semantics are documented on `SearchResultSchema`: cosine similarity
 * normalized to `0..1`.
 *
 * `embed` is optional — backends like Chroma embed internally and have
 * no separate embedding surface exposed to callers; adapters omit it
 * in that case. `close()` tears down any held subprocess / connection
 * pool so tRPC procedures can open-and-close per call without leaking.
 */
export interface RetrievalProvider {
  readonly kind: string;
  search(request: SearchRequest): Promise<SearchResponse>;
  store(request: StoreRequest): Promise<StoreResponse>;
  delete(request: DeleteRequest): Promise<DeleteResponse>;
  listCollections(): Promise<ListCollectionsResponse>;
  embed?(request: UnifiedEmbeddingRequest): Promise<UnifiedEmbeddingResponse>;
  close(): Promise<void>;
}

/**
 * Provider factory descriptor. Registries persist these — consumers
 * call `build(ctx)` to materialize an `AiProvider`. Keeps adapter
 * wiring lazy so the control plane can surface a provider catalog
 * without bringing up every SDK at startup.
 */
export interface ProviderFactory<Ctx = unknown> {
  /** Matches `AiProvider.name` of the instance it builds. */
  readonly name: string;
  /** Human display name, surfaced to the UI. */
  readonly displayName: string;
  /** One-liner describing what this factory produces. */
  readonly description?: string;
  /**
   * Fields the UI should collect before calling `build`. The control
   * plane uses this to render a registration form without hard-coding
   * per-provider knowledge.
   */
  readonly inputs: readonly ProviderFactoryInput[];
  build(ctx: Ctx, inputs: Record<string, string>): AiProvider;
}

export interface ProviderFactoryInput {
  key: string;
  label: string;
  placeholder?: string;
  /** `'secret'` hides the value in UIs and logs. `'url'` hints at a
   *  URL picker / validator. */
  kind: 'text' | 'secret' | 'url';
  required?: boolean;
  /** Default value for non-required fields (e.g. `https://api.openai.com/v1`). */
  default?: string;
}

/**
 * Minimum-viable in-process registry. Keeps the shape tiny on purpose
 * — neither sirius nor embersynth should have to adopt llamactl's
 * registry implementation; the interface is the contract, and each
 * consumer can back it with DI (NestJS), a global Map, or whatever.
 */
export interface ProviderRegistry {
  register(provider: AiProvider): void;
  get(name: string): AiProvider | undefined;
  all(): AiProvider[];
}
