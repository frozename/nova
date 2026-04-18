import { z } from 'zod';
import { FinishReasonSchema, ToolCallSchema } from './chat.js';

/**
 * Unified streaming events. Adapters convert their provider's native
 * SSE / JSONL / whatever into this sequence. Consumers can pipe the
 * events directly to an OpenAI-compatible `data:` SSE stream — the
 * shape mirrors the OpenAI streaming envelope closely enough that a
 * byte-level passthrough stays valid.
 */

export const StreamDeltaSchema = z.object({
  role: z.enum(['assistant', 'tool']).optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});

export const StreamChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: StreamDeltaSchema,
  finish_reason: FinishReasonSchema.nullable().optional(),
});

/**
 * Per-chunk wire envelope. Anthropic-style `message_start` /
 * `message_stop` events fold into this shape: the first chunk carries
 * `role: assistant`, intermediate chunks carry `content` deltas, and
 * the final chunk carries `finish_reason`.
 */
export const UnifiedStreamChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  model: z.string(),
  created: z.number().int(),
  choices: z.array(StreamChoiceSchema).min(1),
});
export type UnifiedStreamChunk = z.infer<typeof UnifiedStreamChunkSchema>;

/**
 * High-level event taxonomy used by orchestrators that want more
 * structure than raw chunks (embersynth multi-stage synthesis, UI
 * chat panels that need distinct tool-call / error states). Adapters
 * MAY yield these instead of raw chunks; routers translate both.
 */
export const UnifiedStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), chunk: UnifiedStreamChunkSchema }),
  z.object({
    type: z.literal('tool_call'),
    toolCall: ToolCallSchema,
    /** Which choice index the call belongs to (for N>1 sampling). */
    choiceIndex: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      message: z.string(),
      code: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('done'),
    finish_reason: FinishReasonSchema.nullable(),
  }),
]);
export type UnifiedStreamEvent = z.infer<typeof UnifiedStreamEventSchema>;
