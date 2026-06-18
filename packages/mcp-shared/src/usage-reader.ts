import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultUsageDir } from "./usage.js";

/**
 * Batch reader for the JSONL usage sink written by `appendUsage()`.
 *
 * Scans `<dir>/*.jsonl`, parses each line as JSON, and returns the
 * records that fall inside an optional time window. Malformed lines
 * are dropped silently — torn writes at the tail of a file can't
 * corrupt the rest of the dataset, and a single bad line should
 * never kill the whole aggregation.
 *
 * Consumers:
 *   - `nova.ops.cost.snapshot` aggregates by provider/model.
 *   - `sirius.usage.recent` returns the raw slice (later slice).
 *   - `llamactl usage reprice` will replay these records joined
 *     against an updated pricing YAML (N.3.4).
 */

export interface UsageReadOptions {
  /** Override usage dir; defaults to `defaultUsageDir()`. */
  dir?: string;
  /** Inclusive lower bound on record ts (ISO). */
  since?: string;
  /** Exclusive upper bound on record ts (ISO). */
  until?: string;
  /** Restrict to a single provider — skip files whose filename
   *  prefix doesn't match. Speeds up large usage directories. */
  provider?: string;
}

export interface UsageReadResult {
  records: Record<string, unknown>[];
  /** Files that were read. Useful for surfacing "we scanned N files"
   *  in the snapshot output. */
  filesScanned: string[];
  /** Count of lines that failed JSON.parse — diagnostic only, not
   *  an error. */
  malformedLines: number;
}

function parseFilename(name: string): { provider: string; date: string } | null {
  // `<provider>-YYYY-MM-DD.jsonl` — provider may contain letters /
  // digits / dot / underscore / hyphen. Match greedily on the
  // trailing date so providers with hyphens (e.g. `openai-compat`)
  // still split cleanly.
  const m = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
  const provider = m?.[1];
  const date = m?.[2];
  if (provider === undefined || date === undefined) return null;
  return { provider, date };
}

interface TimeWindow {
  sinceMs: number;
  untilMs: number;
}

/**
 * Decide whether a file can be skipped without reading it: wrong
 * extension, non-conforming filename, provider mismatch, or a day
 * that falls entirely outside the requested window. Returns the
 * parsed filename when the file should be read, else `null`.
 */
function shouldReadFile(
  name: string,
  opts: UsageReadOptions,
  window: TimeWindow,
): { provider: string; date: string } | null {
  if (!name.endsWith(".jsonl")) return null;
  const parsed = parseFilename(name);
  if (!parsed) return null;
  if (opts.provider && parsed.provider !== opts.provider) return null;
  // Skip files whose date is strictly before `since`'s day or
  // strictly after `until`'s day. Cheap pre-filter — saves reading
  // entire files that can't contain matching records.
  const dayStartMs = Date.parse(`${parsed.date}T00:00:00Z`);
  const dayEndMs = dayStartMs + 86400_000;
  if (dayEndMs <= window.sinceMs) return null;
  if (dayStartMs >= window.untilMs) return null;
  return parsed;
}

/** True when a record's `ts` (if any) falls inside [since, until). */
function inWindow(rec: Record<string, unknown>, window: TimeWindow): boolean {
  const ts = rec['ts'];
  if (typeof ts !== "string") return true;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return true;
  return ms >= window.sinceMs && ms < window.untilMs;
}

/** Parse one file's body line-by-line into `result`, counting torn writes. */
function collectFromBody(body: string, window: TimeWindow, result: UsageReadResult): void {
  for (const line of body.split("\n")) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      result.malformedLines++;
      continue;
    }
    if (inWindow(rec, window)) result.records.push(rec);
  }
}

export function readUsage(opts: UsageReadOptions = {}): UsageReadResult {
  const dir = opts.dir ?? defaultUsageDir();
  const result: UsageReadResult = { records: [], filesScanned: [], malformedLines: 0 };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- usage dir is an internal path (defaultUsageDir or test-injected), not user request input.
  if (!existsSync(dir)) return result;
  const window: TimeWindow = {
    sinceMs: opts.since ? Date.parse(opts.since) : -Infinity,
    untilMs: opts.until ? Date.parse(opts.until) : Infinity,
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same internal usage dir as the existsSync above.
  for (const name of readdirSync(dir).sort()) {
    if (!shouldReadFile(name, opts, window)) continue;
    const path = join(dir, name);
    result.filesScanned.push(path);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is join(internal usage dir, name) where name came from readdirSync of that dir; not attacker-controlled.
    const body = readFileSync(path, "utf8");
    collectFromBody(body, window, result);
  }
  return result;
}
