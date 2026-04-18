import { z } from 'zod';

/**
 * Chat-completion wire types — the OpenAI-compatible dialect is the
 * lingua franca. Schemas stay intentionally narrow: anything a
 * well-behaved provider (OpenAI, Anthropic via its native API, local
 * llama.cpp) can round-trip. Provider-specific knobs go in
 * `providerOptions` (opaque record) rather than the top-level shape.
 */

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool', 'developer']);
export type Role = z.infer<typeof RoleSchema>;

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

// ---- Content blocks ----------------------------------------------------

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageBlockSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const InputAudioBlockSchema = z.object({
  type: z.literal('input_audio'),
  input_audio: z.object({
    data: z.string(),
    format: z.enum(['wav', 'mp3']),
  }),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  InputAudioBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// ---- Messages ----------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema), z.null()]),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---- Tools + response formats -----------------------------------------

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().optional(),
  }),
});
export type Tool = z.infer<typeof ToolSchema>;

export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

export const ResponseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.unknown(),
      strict: z.boolean().optional(),
    }),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

// ---- Unified request / response ---------------------------------------

export const UnifiedAiRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  tools: z.array(ToolSchema).optional(),
  tool_choice: ToolChoiceSchema.optional(),
  response_format: ResponseFormatSchema.optional(),
  user: z.string().optional(),
  /** Opaque bag for provider-specific knobs (seed, logit_bias,
   *  Anthropic `top_k`, llama.cpp sampler flags, …). Adapters may read
   *  this; routers and middleware ignore it. */
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  /** Capability tags for capability-based routers (embersynth-style).
   *  Unused by provider adapters; consumed by orchestrators. */
  capabilities: z.array(z.string()).optional(),
});
export type UnifiedAiRequest = z.infer<typeof UnifiedAiRequestSchema>;

export const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const UnifiedChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: ChatMessageSchema,
  finish_reason: FinishReasonSchema.nullable(),
});

export const UnifiedAiResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  model: z.string(),
  created: z.number().int(),
  choices: z.array(UnifiedChoiceSchema).min(1),
  usage: UsageSchema.optional(),
  /** Wall-clock latency measured by the adapter that produced this
   *  response. Orchestrators aggregate it for SLO dashboards. */
  latencyMs: z.number().nonnegative().optional(),
  /** Provider name that served the request (useful when fallback
   *  chains or capability routers pick among adapters). */
  provider: z.string().optional(),
});
export type UnifiedAiResponse = z.infer<typeof UnifiedAiResponseSchema>;
