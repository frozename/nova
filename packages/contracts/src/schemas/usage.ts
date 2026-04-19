import { z } from 'zod';

/**
 * Unified usage record. Every AI call in the llamactl family —
 * sirius-gateway, embersynth, llamactl's dispatcher — writes one of
 * these into a JSONL sink so operators can roll up spend, routing
 * behavior, and provider mix without each repo inventing its own
 * telemetry shape.
 *
 * Privacy lock: record token counts + model + timestamps, not the
 * prompt content. Rich enough for cost analytics without becoming
 * a secondary prompt log. The only free-form fields are `request_id`
 * (opaque correlation id) and `route` (embersynth profile or sirius
 * route slug), both operator-chosen strings.
 *
 * Schema design note: `estimated_cost_usd` is intentionally
 * optional. Pricing tables drift; the token counts are authoritative
 * and stay forever. Missing pricing at write time → leave cost
 * blank; a separate `llamactl usage reprice` pass fills it in
 * retroactively.
 */

export const UsageKindSchema = z.enum(['chat', 'embedding', 'responses']);
export type UsageKind = z.infer<typeof UsageKindSchema>;

export const UsageRecordSchema = z.object({
  /** ISO-8601 UTC. */
  ts: z.string().min(1),
  /** e.g. 'openai', 'anthropic', 'sirius', 'local', 'embersynth'. */
  provider: z.string().min(1),
  /** The model the upstream API actually served. */
  model: z.string().min(1),
  kind: UsageKindSchema,
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  /** Wall-clock latency the adapter measured. */
  latency_ms: z.number().nonnegative(),
  /** Opaque correlation id for cross-referencing with traces. */
  request_id: z.string().optional(),
  /** Filled lazily when pricing is available — never required at write time. */
  estimated_cost_usd: z.number().optional(),
  /** Opt-in only; most clients leave this unset. */
  user: z.string().optional(),
  /** Embersynth profile id / sirius routing slug that dispatched. */
  route: z.string().optional(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/**
 * Helper type for adapters that only have raw counts. The writer
 * fills in ts + latency + provider identity; callers supply the
 * token numbers.
 */
export interface MinimalUsageInput {
  provider: string;
  model: string;
  kind: UsageKind;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  request_id?: string;
  route?: string;
  user?: string;
}
