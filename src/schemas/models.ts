import { z } from 'zod';

/**
 * Model catalog. `ModelInfo` is the canonical shape for "what can
 * this provider serve" — it round-trips OpenAI's `/v1/models`
 * response, adds a capabilities vector for routers, and keeps an
 * optional per-provider cost field so cost-aware policies can sort.
 */

export const ModelCapabilitySchema = z.enum([
  'chat',
  'embeddings',
  'reasoning',
  'vision',
  'audio',
  'tools',
  'json_mode',
  'structured_output',
  'long_context',
  'code',
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ModelCostSchema = z.object({
  /** USD per 1M input tokens. Null when the provider is free / local. */
  inputPerMTokUsd: z.number().nonnegative().nullable().optional(),
  outputPerMTokUsd: z.number().nonnegative().nullable().optional(),
});

export const ModelInfoSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  /** Seconds-since-epoch, matching OpenAI's `created` field. */
  created: z.number().int(),
  /** Provider name — "openai", "anthropic", "llamactl-agent", etc.
   *  Maps to OpenAI's `owned_by`. */
  owned_by: z.string(),
  /** Capabilities the model advertises. Routers use this for
   *  capability-based dispatch; UIs render badges. */
  capabilities: z.array(ModelCapabilitySchema).default([]),
  /** Maximum input context window in tokens. Null when unknown. */
  contextLength: z.number().int().positive().nullable().optional(),
  /** Maximum output length in tokens. Null when unconstrained. */
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  cost: ModelCostSchema.optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ModelListResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(ModelInfoSchema),
});
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;
