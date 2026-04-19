import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultUsageDir } from './usage.js';

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
  records: Array<Record<string, unknown>>;
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
  if (!m) return null;
  return { provider: m[1]!, date: m[2]! };
}

export function readUsage(opts: UsageReadOptions = {}): UsageReadResult {
  const dir = opts.dir ?? defaultUsageDir();
  const result: UsageReadResult = { records: [], filesScanned: [], malformedLines: 0 };
  if (!existsSync(dir)) return result;
  const sinceMs = opts.since ? Date.parse(opts.since) : -Infinity;
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const parsed = parseFilename(name);
    if (!parsed) continue;
    if (opts.provider && parsed.provider !== opts.provider) continue;
    // Skip files whose date is strictly before `since`'s day or
    // strictly after `until`'s day. Cheap pre-filter — saves reading
    // entire files that can't contain matching records.
    const dayStartMs = Date.parse(`${parsed.date}T00:00:00Z`);
    const dayEndMs = dayStartMs + 86400_000;
    if (dayEndMs <= sinceMs) continue;
    if (dayStartMs >= untilMs) continue;
    const path = join(dir, name);
    result.filesScanned.push(path);
    const body = readFileSync(path, 'utf8');
    for (const line of body.split('\n')) {
      if (!line) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result.malformedLines++;
        continue;
      }
      const ts = rec.ts;
      if (typeof ts === 'string') {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms)) {
          if (ms < sinceMs || ms >= untilMs) continue;
        }
      }
      result.records.push(rec);
    }
  }
  return result;
}
