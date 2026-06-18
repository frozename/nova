import {
  type ModelPricing,
  type PricingCatalog,
  type ProviderPricing,
  ProviderPricingSchema,
  type UsageRecord,
} from "@nova/contracts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * File-backed pricing catalog + cost estimator.
 *
 * - `defaultPricingDir()` — `$LLAMACTL_PRICING_DIR` || `$DEV_STORAGE/pricing` ||
 *   `~/.llamactl/pricing`.
 * - `loadPricing({ dir? })` — scans `<dir>/*.yaml`, validates each
 *   against `ProviderPricingSchema`, returns an in-memory
 *   `PricingCatalog`. Malformed files are skipped (counted, not
 *   thrown) so a typo in one provider's YAML can't take down the
 *   whole cost pipeline.
 * - `estimateCostUsd(record, catalog)` — returns the dollar
 *   estimate for a single UsageRecord or `undefined` when the
 *   provider/model isn't in the catalog. Pure; no I/O.
 *
 * Storage policy (see `@nova/contracts/schemas/pricing.ts`): one
 * YAML file per provider under the pricing dir. File basename
 * doesn't have to match the provider field inside — the `provider`
 * field wins, the filename is a human convenience.
 */

export function defaultPricingDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_PRICING_DIR?.trim();
  if (override) return override;
  const devStorage = env.DEV_STORAGE?.trim();
  const base = devStorage && devStorage.length > 0 ? devStorage : join(homedir(), ".llamactl");
  return join(base, "pricing");
}

export interface LoadPricingOptions {
  dir?: string;
}

export interface LoadPricingResult {
  catalog: PricingCatalog;
  filesLoaded: string[];
  malformedFiles: { path: string; message: string }[];
}

export function loadPricing(opts: LoadPricingOptions = {}): LoadPricingResult {
  const dir = opts.dir ?? defaultPricingDir();
  const catalog: PricingCatalog = new Map();
  const filesLoaded: string[] = [];
  const malformedFiles: LoadPricingResult["malformedFiles"] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- pricing dir is an internal config path (LLAMACTL_PRICING_DIR / DEV_STORAGE / ~/.llamactl or test-injected), not user request input.
  if (!existsSync(dir)) return { catalog, filesLoaded, malformedFiles };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same internal pricing dir as the existsSync above.
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is join(internal pricingDir, name) where name came from readdirSync of that same internal dir; not attacker-controlled.
      raw = readFileSync(path, "utf8");
    } catch (err) {
      malformedFiles.push({ path, message: (err as Error).message });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      malformedFiles.push({ path, message: `YAML parse: ${(err as Error).message}` });
      continue;
    }
    const result = ProviderPricingSchema.safeParse(parsed);
    if (!result.success) {
      malformedFiles.push({
        path,
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    filesLoaded.push(path);
    catalog.set(result.data.provider, result.data);
  }
  return { catalog, filesLoaded, malformedFiles };
}

/**
 * Pure cost lookup. Returns `undefined` when pricing is unknown for
 * the (provider, model) pair. Chat + responses bill both token
 * streams; embedding kind bills only the prompt side.
 */
export function estimateCostUsd(
  record: Pick<UsageRecord, "provider" | "model" | "kind" | "prompt_tokens" | "completion_tokens">,
  catalog: PricingCatalog,
): number | undefined {
  const providerPricing = catalog.get(record.provider);
  if (!providerPricing) return undefined;
  const modelPricing = providerPricing.models[record.model];
  if (!modelPricing) return undefined;
  return computeCost(modelPricing, record.prompt_tokens, record.completion_tokens);
}

export function computeCost(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): number {
  const promptCost = (promptTokens / 1000) * pricing.prompt_per_1k_tokens_usd;
  const completionCost = (completionTokens / 1000) * pricing.completion_per_1k_tokens_usd;
  // Guard against -0.
  const total = promptCost + completionCost;
  return total === 0 ? 0 : total;
}

/**
 * Lookup the raw pricing entry for a (provider, model) pair. Useful
 * when a caller needs more than the final dollar figure — e.g., to
 * render the rate in a UI tooltip.
 */
export function findModelPricing(
  provider: string,
  model: string,
  catalog: PricingCatalog,
): { provider: ProviderPricing; model: ModelPricing } | undefined {
  const providerPricing = catalog.get(provider);
  if (!providerPricing) return undefined;
  const modelPricing = providerPricing.models[model];
  if (!modelPricing) return undefined;
  return { provider: providerPricing, model: modelPricing };
}
