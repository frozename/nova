import { z } from 'zod';

/**
 * Per-provider pricing catalog. One YAML file per provider under
 * `~/.llamactl/pricing/<provider>.yaml`. Consumed by
 * `nova.ops.cost.snapshot`'s pricing join and the upcoming
 * `llamactl usage reprice` replay command.
 *
 * Shape stays intentionally narrow: prompt + completion per-1k-
 * token rates in USD. Providers that bill differently (per-second
 * compute, per-image, per-request fixed fee) can extend through
 * `meta` — we pass unknown keys through so operators can annotate
 * — but the headline cost calculation always uses the two rate
 * fields.
 *
 * Missing pricing is not an error. The cost estimator returns
 * `undefined` for records whose provider/model isn't in the
 * catalog; the snapshot continues to surface token totals even
 * when costs are blank.
 *
 * Storage layout:
 *   ~/.llamactl/pricing/
 *   ├── openai.yaml
 *   ├── anthropic.yaml
 *   ├── together.yaml
 *   └── <other>.yaml
 *
 * YAML shape:
 *   provider: openai
 *   models:
 *     gpt-4o-mini:
 *       prompt_per_1k_tokens_usd: 0.00015
 *       completion_per_1k_tokens_usd: 0.0006
 *     text-embedding-3-small:
 *       prompt_per_1k_tokens_usd: 0.00002
 *       completion_per_1k_tokens_usd: 0  # embedding = no completion
 */

export const ModelPricingSchema = z.object({
  prompt_per_1k_tokens_usd: z.number().nonnegative(),
  completion_per_1k_tokens_usd: z.number().nonnegative(),
  /** Free-form — operator annotations, per-second rates for exotic
   *  providers, etc. Passthrough; not consumed by the estimator. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ProviderPricingSchema = z.object({
  provider: z.string().min(1),
  /** Map from model id (exactly as it appears in the UsageRecord)
   *  to its pricing. Model ids not listed here are skipped at the
   *  estimator. */
  models: z.record(z.string(), ModelPricingSchema),
  /** Source URL / last-updated annotation. Passthrough only. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

/**
 * In-memory pricing catalog: `provider → model → rates`. Built by
 * `loadPricing()` (in `@nova/mcp-shared`) from the files under the
 * pricing directory. Consumers treat it as opaque; use
 * `estimateCostUsd()` to look up.
 */
export type PricingCatalog = Map<string, ProviderPricing>;
