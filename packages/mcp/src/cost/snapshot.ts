import {
  estimateCostUsd,
  loadPricing,
  readUsage,
  type LoadPricingResult,
  type UsageReadOptions,
} from '@nova/mcp-shared';
import type { PricingCatalog } from '@nova/contracts';

/**
 * Pure aggregator for the usage JSONL corpus. Given a time window,
 * an optional usage dir, and an optional pricing dir, returns roll-
 * ups grouped by provider and by (provider, model) — plus a totals
 * block.
 *
 * When pricing is discoverable (files exist under the pricing dir
 * and validate against `ProviderPricingSchema`), each record's
 * estimated USD cost is summed into per-group and top-level totals.
 * Missing pricing stays `undefined` on the affected groups — the
 * aggregation never blocks on a missing rate table.
 *
 * Separated from the MCP tool registration so callers outside
 * `@nova/mcp` (CLI + Electron + a future cost-guardian agent) can
 * invoke the same aggregation without booting a server.
 */

export interface CostGroup {
  key: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  /** Sum of per-record `estimated_cost_usd` where pricing was
   *  available. `undefined` when no record in the group had
   *  pricing; a numeric value (possibly 0) means at least one
   *  record's cost was computed and included. */
  estimatedCostUsd?: number;
  /** Count of records in this group whose provider/model was not
   *  in the pricing catalog. A non-zero value alongside
   *  `estimatedCostUsd` means the total understates real spend. */
  recordsMissingPricing: number;
}

export interface CostSnapshot {
  windowSince: string;
  windowUntil: string;
  filesScanned: number;
  malformedLines: number;
  totalRequests: number;
  totalTokens: number;
  /** Sum of record-level `estimated_cost_usd` where pricing was
   *  available. `undefined` when no record matched. */
  totalEstimatedCostUsd?: number;
  recordsMissingPricing: number;
  pricingFilesLoaded: number;
  pricingFilesMalformed: number;
  byProvider: CostGroup[];
  byModel: CostGroup[];
}

export interface CostSnapshotOptions {
  /** Window length in days (UTC). Default 7. Capped at 90 by the
   *  caller — this module accepts any positive number. */
  days?: number;
  /** Override usage dir for tests / CI. */
  dir?: string;
  /** Override pricing dir. `null` disables pricing lookup entirely
   *  (useful when the caller wants token-only aggregation even in
   *  environments that happen to ship a pricing dir). */
  pricingDir?: string | null;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Pre-loaded catalog. When set, skips disk reads entirely; tests
   *  inject canned catalogs through this path. */
  pricing?: PricingCatalog;
}

interface Accumulator {
  count: number;
  prompt: number;
  completion: number;
  total: number;
  latencySum: number;
  /** Sum of per-record cost estimates. `null` when no record has
   *  contributed a priced estimate yet — switches to a number the
   *  first time one does. */
  costSum: number | null;
  recordsMissingPricing: number;
}

function emptyAcc(): Accumulator {
  return {
    count: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    latencySum: 0,
    costSum: null,
    recordsMissingPricing: 0,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toGroup(key: string, acc: Accumulator): CostGroup {
  const group: CostGroup = {
    key,
    requestCount: acc.count,
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    totalTokens: acc.total,
    avgLatencyMs: acc.count > 0 ? acc.latencySum / acc.count : 0,
    recordsMissingPricing: acc.recordsMissingPricing,
  };
  if (acc.costSum !== null) {
    group.estimatedCostUsd = acc.costSum;
  }
  return group;
}

export function computeCostSnapshot(opts: CostSnapshotOptions = {}): CostSnapshot {
  const now = opts.now ? opts.now() : new Date();
  const days = opts.days && opts.days > 0 ? opts.days : 7;
  const untilMs = now.getTime();
  const sinceMs = untilMs - days * 86400_000;
  const readOpts: UsageReadOptions = {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
  };
  if (opts.dir !== undefined) readOpts.dir = opts.dir;
  const read = readUsage(readOpts);

  let catalog: PricingCatalog;
  let pricingLoad: LoadPricingResult = {
    catalog: new Map(),
    filesLoaded: [],
    malformedFiles: [],
  };
  if (opts.pricing) {
    catalog = opts.pricing;
  } else if (opts.pricingDir === null) {
    catalog = new Map();
  } else {
    pricingLoad = loadPricing(
      opts.pricingDir !== undefined ? { dir: opts.pricingDir } : {},
    );
    catalog = pricingLoad.catalog;
  }

  const byProvider = new Map<string, Accumulator>();
  const byModel = new Map<string, Accumulator>();
  let totalRequests = 0;
  let totalTokens = 0;
  let totalCost: number | null = null;
  let totalMissingPricing = 0;

  for (const r of read.records) {
    const provider = str(r.provider);
    const model = str(r.model);
    if (!provider || !model) continue;
    const prompt = num(r.prompt_tokens);
    const completion = num(r.completion_tokens);
    const total = num(r.total_tokens);
    const latency = num(r.latency_ms);
    const kind = (r.kind as 'chat' | 'embedding' | 'responses') ?? 'chat';

    const priced = estimateCostUsd(
      {
        provider,
        model,
        kind,
        prompt_tokens: prompt,
        completion_tokens: completion,
      },
      catalog,
    );
    const missing = priced === undefined;
    if (missing) totalMissingPricing++;

    const pAcc = byProvider.get(provider) ?? emptyAcc();
    pAcc.count++;
    pAcc.prompt += prompt;
    pAcc.completion += completion;
    pAcc.total += total;
    pAcc.latencySum += latency;
    if (priced !== undefined) {
      pAcc.costSum = (pAcc.costSum ?? 0) + priced;
    } else {
      pAcc.recordsMissingPricing++;
    }
    byProvider.set(provider, pAcc);

    const modelKey = `${provider}/${model}`;
    const mAcc = byModel.get(modelKey) ?? emptyAcc();
    mAcc.count++;
    mAcc.prompt += prompt;
    mAcc.completion += completion;
    mAcc.total += total;
    mAcc.latencySum += latency;
    if (priced !== undefined) {
      mAcc.costSum = (mAcc.costSum ?? 0) + priced;
    } else {
      mAcc.recordsMissingPricing++;
    }
    byModel.set(modelKey, mAcc);

    totalRequests++;
    totalTokens += total;
    if (priced !== undefined) {
      totalCost = (totalCost ?? 0) + priced;
    }
  }

  const providerGroups = Array.from(byProvider.entries())
    .map(([k, a]) => toGroup(k, a))
    // Sort by cost if we have any, else by totalTokens.
    .sort((a, b) => {
      const ac = a.estimatedCostUsd ?? -1;
      const bc = b.estimatedCostUsd ?? -1;
      if (ac !== bc) return bc - ac;
      return b.totalTokens - a.totalTokens;
    });
  const modelGroups = Array.from(byModel.entries())
    .map(([k, a]) => toGroup(k, a))
    .sort((a, b) => {
      const ac = a.estimatedCostUsd ?? -1;
      const bc = b.estimatedCostUsd ?? -1;
      if (ac !== bc) return bc - ac;
      return b.totalTokens - a.totalTokens;
    });

  const snapshot: CostSnapshot = {
    windowSince: new Date(sinceMs).toISOString(),
    windowUntil: new Date(untilMs).toISOString(),
    filesScanned: read.filesScanned.length,
    malformedLines: read.malformedLines,
    totalRequests,
    totalTokens,
    recordsMissingPricing: totalMissingPricing,
    pricingFilesLoaded: pricingLoad.filesLoaded.length,
    pricingFilesMalformed: pricingLoad.malformedFiles.length,
    byProvider: providerGroups,
    byModel: modelGroups,
  };
  if (totalCost !== null) {
    snapshot.totalEstimatedCostUsd = totalCost;
  }
  return snapshot;
}
