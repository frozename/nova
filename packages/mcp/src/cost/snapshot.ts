import { readUsage, type UsageReadOptions } from '@nova/mcp-shared';

/**
 * Pure aggregator for the usage JSONL corpus. Given a time window
 * and an optional dir override, returns roll-ups grouped by provider
 * and by (provider, model) — plus a totals block.
 *
 * Pricing join (cents per 1k tokens) is deferred to N.3.4. When
 * pricing lands, each `CostGroup` gains an `estimatedCostUsd` field
 * computed from a lookup; for now we only know tokens + counts.
 *
 * Separated from the MCP tool registration so callers outside
 * `@nova/mcp` (CLI + Electron) can invoke the same aggregation
 * without booting a server.
 */

export interface CostGroup {
  key: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface CostSnapshot {
  windowSince: string;
  windowUntil: string;
  filesScanned: number;
  malformedLines: number;
  totalRequests: number;
  totalTokens: number;
  byProvider: CostGroup[];
  byModel: CostGroup[];
}

export interface CostSnapshotOptions {
  /** Window length in days (UTC). Default 7. Capped at 90 by the
   *  caller — this module accepts any positive number. */
  days?: number;
  /** Override usage dir for tests / CI. */
  dir?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

interface Accumulator {
  count: number;
  prompt: number;
  completion: number;
  total: number;
  latencySum: number;
}

function emptyAcc(): Accumulator {
  return { count: 0, prompt: 0, completion: 0, total: 0, latencySum: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toGroup(key: string, acc: Accumulator): CostGroup {
  return {
    key,
    requestCount: acc.count,
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    totalTokens: acc.total,
    avgLatencyMs: acc.count > 0 ? acc.latencySum / acc.count : 0,
  };
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
  const byProvider = new Map<string, Accumulator>();
  const byModel = new Map<string, Accumulator>();
  let totalRequests = 0;
  let totalTokens = 0;
  for (const r of read.records) {
    const provider = str(r.provider);
    const model = str(r.model);
    if (!provider || !model) continue;
    const prompt = num(r.prompt_tokens);
    const completion = num(r.completion_tokens);
    const total = num(r.total_tokens);
    const latency = num(r.latency_ms);
    const pAcc = byProvider.get(provider) ?? emptyAcc();
    pAcc.count++;
    pAcc.prompt += prompt;
    pAcc.completion += completion;
    pAcc.total += total;
    pAcc.latencySum += latency;
    byProvider.set(provider, pAcc);
    const modelKey = `${provider}/${model}`;
    const mAcc = byModel.get(modelKey) ?? emptyAcc();
    mAcc.count++;
    mAcc.prompt += prompt;
    mAcc.completion += completion;
    mAcc.total += total;
    mAcc.latencySum += latency;
    byModel.set(modelKey, mAcc);
    totalRequests++;
    totalTokens += total;
  }
  const providerGroups = Array.from(byProvider.entries())
    .map(([k, a]) => toGroup(k, a))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const modelGroups = Array.from(byModel.entries())
    .map(([k, a]) => toGroup(k, a))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    windowSince: new Date(sinceMs).toISOString(),
    windowUntil: new Date(untilMs).toISOString(),
    filesScanned: read.filesScanned.length,
    malformedLines: read.malformedLines,
    totalRequests,
    totalTokens,
    byProvider: providerGroups,
    byModel: modelGroups,
  };
}
