import type { PricingCatalog } from "@nova/contracts";

import {
  estimateCostUsd,
  loadPricing,
  type LoadPricingResult,
  readUsage,
  type UsageReadOptions,
} from "@nova/mcp-shared";

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
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Fold one record's tallies into the keyed accumulator map, creating
 *  the bucket on first sight. `priced` is the per-record dollar
 *  estimate (or `undefined` when pricing was unavailable). */
function accumulate(
  map: Map<string, Accumulator>,
  key: string,
  prompt: number,
  completion: number,
  total: number,
  latency: number,
  priced: number | undefined,
): void {
  const acc = map.get(key) ?? emptyAcc();
  acc.count++;
  acc.prompt += prompt;
  acc.completion += completion;
  acc.total += total;
  acc.latencySum += latency;
  if (priced !== undefined) {
    acc.costSum = (acc.costSum ?? 0) + priced;
  } else {
    acc.recordsMissingPricing++;
  }
  map.set(key, acc);
}

/** Group ordering: cost descending when any group has cost, falling
 *  back to total tokens (groups without cost sort as -1). */
function compareGroups(a: CostGroup, b: CostGroup): number {
  const ac = a.estimatedCostUsd ?? -1;
  const bc = b.estimatedCostUsd ?? -1;
  if (ac !== bc) return bc - ac;
  return b.totalTokens - a.totalTokens;
}

/** Resolve which pricing catalog to bill against, plus the load
 *  result (file counts) when disk was touched. Injected catalog and
 *  `pricingDir: null` both skip disk entirely. */
function resolveCatalog(opts: CostSnapshotOptions): {
  catalog: PricingCatalog;
  pricingLoad: LoadPricingResult;
} {
  const empty: LoadPricingResult = { catalog: new Map(), filesLoaded: [], malformedFiles: [] };
  if (opts.pricing) {
    return { catalog: opts.pricing, pricingLoad: empty };
  }
  if (opts.pricingDir === null) {
    return { catalog: new Map(), pricingLoad: empty };
  }
  const pricingLoad = loadPricing(opts.pricingDir !== undefined ? { dir: opts.pricingDir } : {});
  return { catalog: pricingLoad.catalog, pricingLoad };
}

interface Tallies {
  byProvider: Map<string, Accumulator>;
  byModel: Map<string, Accumulator>;
  totalRequests: number;
  totalTokens: number;
  totalCost: number | null;
  totalMissingPricing: number;
}

/** Fold every usage record into per-provider / per-model accumulators
 *  plus running grand totals. Records missing provider or model are
 *  skipped; `kind` is normalized to the billing enum. */
function tallyRecords(records: Record<string, unknown>[], catalog: PricingCatalog): Tallies {
  const t: Tallies = {
    byProvider: new Map(),
    byModel: new Map(),
    totalRequests: 0,
    totalTokens: 0,
    totalCost: null,
    totalMissingPricing: 0,
  };
  for (const r of records) {
    const provider = str(r['provider']);
    const model = str(r['model']);
    if (!provider || !model) continue;
    const prompt = num(r['prompt_tokens']);
    const completion = num(r['completion_tokens']);
    const total = num(r['total_tokens']);
    const latency = num(r['latency_ms']);
    const kind: "chat" | "embedding" | "responses" =
      r['kind'] === "embedding" || r['kind'] === "responses" ? r['kind'] : "chat";

    const priced = estimateCostUsd(
      { provider, model, kind, prompt_tokens: prompt, completion_tokens: completion },
      catalog,
    );
    if (priced === undefined) t.totalMissingPricing++;

    accumulate(t.byProvider, provider, prompt, completion, total, latency, priced);
    accumulate(t.byModel, `${provider}/${model}`, prompt, completion, total, latency, priced);

    t.totalRequests++;
    t.totalTokens += total;
    if (priced !== undefined) {
      t.totalCost = (t.totalCost ?? 0) + priced;
    }
  }
  return t;
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

  const { catalog, pricingLoad } = resolveCatalog(opts);
  const t = tallyRecords(read.records, catalog);

  const providerGroups = Array.from(t.byProvider.entries())
    .map(([k, a]) => toGroup(k, a))
    .sort(compareGroups);
  const modelGroups = Array.from(t.byModel.entries())
    .map(([k, a]) => toGroup(k, a))
    .sort(compareGroups);

  const snapshot: CostSnapshot = {
    windowSince: new Date(sinceMs).toISOString(),
    windowUntil: new Date(untilMs).toISOString(),
    filesScanned: read.filesScanned.length,
    malformedLines: read.malformedLines,
    totalRequests: t.totalRequests,
    totalTokens: t.totalTokens,
    recordsMissingPricing: t.totalMissingPricing,
    pricingFilesLoaded: pricingLoad.filesLoaded.length,
    pricingFilesMalformed: pricingLoad.malformedFiles.length,
    byProvider: providerGroups,
    byModel: modelGroups,
  };
  if (t.totalCost !== null) {
    snapshot.totalEstimatedCostUsd = t.totalCost;
  }
  return snapshot;
}
