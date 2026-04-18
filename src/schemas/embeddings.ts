import { z } from 'zod';

/**
 * Embedding wire types. OpenAI-compatible: callers POST
 * `{ model, input }`, get back `{ data: [{ embedding, index }] }`.
 * Adapters for providers that diverge (Cohere's multi-field input,
 * Anthropic's embedding beta) translate in both directions.
 */

export const UnifiedEmbeddingRequestSchema = z.object({
  model: z.string(),
  /** One or many inputs. OpenAI accepts both string and array; we
   *  normalize to arrays internally but keep the union on the wire
   *  for passthrough fidelity. */
  input: z.union([z.string(), z.array(z.string()), z.array(z.number()), z.array(z.array(z.number()))]),
  user: z.string().optional(),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});
export type UnifiedEmbeddingRequest = z.infer<typeof UnifiedEmbeddingRequestSchema>;

export const EmbeddingRowSchema = z.object({
  object: z.literal('embedding'),
  index: z.number().int().nonnegative(),
  embedding: z.union([z.array(z.number()), z.string()]),
});

export const UnifiedEmbeddingResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(EmbeddingRowSchema).min(1),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).optional(),
  latencyMs: z.number().nonnegative().optional(),
  provider: z.string().optional(),
});
export type UnifiedEmbeddingResponse = z.infer<typeof UnifiedEmbeddingResponseSchema>;
