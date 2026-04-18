import { z } from 'zod';

/**
 * Provider health. Adapters report; orchestrators decide whether to
 * route traffic. Three-state state machine keeps the model stable
 * under transient failures — a single blip flips to `degraded`
 * before full removal from the pool.
 */

export const ProviderHealthStateSchema = z.enum([
  'healthy',
  'degraded',
  'unhealthy',
  'unknown',
]);
export type ProviderHealthState = z.infer<typeof ProviderHealthStateSchema>;

export const ProviderHealthSchema = z.object({
  state: ProviderHealthStateSchema,
  /** ISO-8601 timestamp of the last probe. */
  lastChecked: z.string(),
  /** Round-trip latency of the most recent health probe, in ms. */
  latencyMs: z.number().nonnegative().nullable().optional(),
  /** When `state !== 'healthy'`, the human-readable reason. */
  error: z.string().nullable().optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
