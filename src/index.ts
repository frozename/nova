/**
 * Nova — canonical AI-provider contracts.
 *
 * Goal: every AI surface in the llamactl family (control plane, agent
 * gateway, sirius-gateway's router, embersynth's adapters) describes
 * chat, embeddings, models, and health in one shared vocabulary. New
 * provider adapters implement `AiProvider`; routing layers compose
 * them; user-facing surfaces render `ModelInfo` / `ProviderHealth`
 * without re-learning each SDK's shape.
 *
 * This package is the seed of the Nova SDK. Today's scope is:
 *   - Zod schemas for wire-crossing types (request / response).
 *   - TypeScript interfaces for runtime abstractions (AiProvider).
 *   - Narrow shared primitives (Role, FinishReason, ContentBlock).
 *   - **No runtime logic.** No HTTP, no SDK wrappers, no file I/O.
 *
 * Next phase adds a thin SDK layer (client helpers, a retry-aware
 * adapter base class, streaming parsers) without disturbing the
 * contracts above.
 */

export * from './schemas/chat.js';
export * from './schemas/embeddings.js';
export * from './schemas/models.js';
export * from './schemas/stream.js';
export * from './schemas/health.js';
export * from './provider.js';
export * from './providers/openai-compat.js';
