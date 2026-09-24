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

// ---- Usage observations (V2 accounting) --------------------------------

/**
 * Where the numbers in a UsageObservationV1 came from.
 *  - 'observed': the upstream API reported them.
 *  - 'estimated': derived locally (tokenizer guess, pricing-table
 *    projection) — real numbers, but not upstream-attested.
 *  - 'unknown': the upstream returned no usage data. Carries no
 *    counts at all; the schema enforces that.
 */
export const UsageObservationSourceSchema = z.enum([
  'observed',
  'estimated',
  'unknown',
]);
export type UsageObservationSource = z.infer<typeof UsageObservationSourceSchema>;

const countField = z.number().int().nonnegative().optional();

/**
 * Separately attributed usage counts with provenance. The core
 * invariant: a missing component stays absent — never written as 0 —
 * so downstream cost math can distinguish "upstream reported zero"
 * from "upstream didn't say". `input_tokens`/`output_tokens` are the
 * V2 names for V1's `prompt_tokens`/`completion_tokens`.
 *
 * `source: 'unknown'` is schema-forbidden from carrying any count or
 * cost field — an observation without data cannot invent one.
 */
export const UsageObservationV1Schema = z
  .object({
    source: UsageObservationSourceSchema,
    /** Prompt-side tokens the upstream actually reported. */
    input_tokens: countField,
    /** Completion-side tokens the upstream actually reported. */
    output_tokens: countField,
    total_tokens: countField,
    /** Tokens served from a provider-side prompt cache (Anthropic-style). */
    cache_read_tokens: countField,
    /** Tokens written into a provider-side prompt cache. */
    cache_write_tokens: countField,
    /** Attributed cost in `currency` units, when known. */
    cost: z.number().nonnegative().optional(),
    /** ISO-4217-style code qualifying `cost` (e.g. 'USD'). */
    currency: z.string().min(1).optional(),
    /** Pricing-table revision the cost was computed against. */
    pricing_revision: z.string().optional(),
    /** The upstream API's own request id (e.g. 'chatcmpl-…'), when exposed. */
    upstream_request_id: z.string().optional(),
  })
  .check((ctx) => {
    if (ctx.value.source !== 'unknown') return;
    for (const key of [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
    ] as const) {
      if (ctx.value[key] !== undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `source 'unknown' must not carry ${key}`,
          input: ctx.value,
        });
      }
    }
  });
export type UsageObservationV1 = z.infer<typeof UsageObservationV1Schema>;

/**
 * UsageRecord v2 — the V1 identity fields plus a provenance-tagged
 * observation and retry-attempt identity. Written to a separate
 * versioned sink so V1 readers never silently receive V2 rows; a V1
 * row is derived only via `projectUsageRecordV2ToV1`, and only when
 * every V1 count was fully observed.
 */
export const UsageRecordV2Schema = z.object({
  /** Wire-format tag so mixed sinks can route rows without sniffing. */
  v: z.literal(2),
  /** ISO-8601 UTC. */
  ts: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  kind: UsageKindSchema,
  latency_ms: z.number().nonnegative(),
  observation: UsageObservationV1Schema,
  request_id: z.string().optional(),
  /** Which attempt within a retried logical request produced this row. */
  attempt_id: z.string().optional(),
  user: z.string().optional(),
  route: z.string().optional(),
});
export type UsageRecordV2 = z.infer<typeof UsageRecordV2Schema>;

/**
 * Project a V2 record onto the legacy V1 shape. Permitted only when
 * every V1 count was fully observed — a partial or non-observed
 * observation returns null rather than fabricating a zero-filled
 * record. Cost maps to `estimated_cost_usd` only when attributed in
 * USD.
 */
export function projectUsageRecordV2ToV1(record: UsageRecordV2): UsageRecord | null {
  const o = record.observation;
  if (
    o.source !== 'observed' ||
    o.input_tokens === undefined ||
    o.output_tokens === undefined ||
    o.total_tokens === undefined
  ) {
    return null;
  }
  return {
    ts: record.ts,
    provider: record.provider,
    model: record.model,
    kind: record.kind,
    prompt_tokens: o.input_tokens,
    completion_tokens: o.output_tokens,
    total_tokens: o.total_tokens,
    latency_ms: record.latency_ms,
    ...(record.request_id !== undefined ? { request_id: record.request_id } : {}),
    ...(o.cost !== undefined && o.currency === 'USD'
      ? { estimated_cost_usd: o.cost }
      : {}),
    ...(record.user !== undefined ? { user: record.user } : {}),
    ...(record.route !== undefined ? { route: record.route } : {}),
  };
}
