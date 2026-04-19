import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Append-only JSONL sink for UsageRecord entries. Same shape as
 * the audit sink (`audit.ts`) — one line per entry, rotated by
 * (provider, day). Readable by a trivial `cat <dir>/*.jsonl | jq`
 * pipeline and by `nova.ops.cost.snapshot`'s batch aggregator.
 *
 * Storage path:
 *   ~/.llamactl/usage/<provider>-<YYYY-MM-DD>.jsonl
 * Env override: `LLAMACTL_USAGE_DIR`.
 *
 * Writer policy — fire-and-forget. The caller should not await
 * this in a hot path that's already in the middle of responding
 * to a user request; schedule it with queueMicrotask / setImmediate
 * so a slow disk doesn't bleed into request latency.
 */

export interface UsageWriteOptions {
  /** Any object that matches UsageRecordSchema shape from
   *  `@nova/contracts`. Kept as `unknown` here so mcp-shared doesn't
   *  need @nova/contracts as a dep — the sink is a byte writer, the
   *  schema is enforced at the adapter boundary. */
  record: unknown;
  /** Override the usage directory (tests). */
  dir?: string;
  /** Clock injection (tests). */
  now?: () => Date;
}

export function defaultUsageDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_USAGE_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'usage');
}

function usageFilePath(dir: string, provider: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  // Sanitize: provider slug must not contain path separators.
  const slug = provider.replace(/[^a-z0-9._-]/gi, '_');
  return join(dir, `${slug}-${y}-${m}-${d}.jsonl`);
}

/**
 * Append one usage record. Requires `record` to have a `provider`
 * field (string) so the file-naming works. Everything else is
 * opaque to this writer.
 */
export function appendUsage(opts: UsageWriteOptions): string {
  const r = opts.record as { provider?: unknown; ts?: unknown };
  if (typeof r?.provider !== 'string' || r.provider.length === 0) {
    throw new Error('appendUsage: record.provider is required');
  }
  const now = (opts.now ?? (() => new Date()))();
  const dir = opts.dir ?? defaultUsageDir();
  const path = usageFilePath(dir, r.provider, now);
  mkdirSync(dirname(path), { recursive: true });
  // Normalize `ts` — if the caller didn't supply one, stamp with now.
  // Avoids each write site having to remember to set it.
  const enriched =
    typeof r.ts === 'string' && r.ts.length > 0
      ? r
      : { ...(opts.record as object), ts: now.toISOString() };
  appendFileSync(path, `${JSON.stringify(enriched)}\n`, 'utf8');
  return path;
}

/**
 * Fire-and-forget wrapper for the hot path. Catches + swallows
 * errors — a full disk should never kill an in-flight user
 * response. Errors surface through the per-day file not growing;
 * the operator notices via `nova.ops.cost.snapshot` reporting
 * zero traffic.
 *
 * Call like:
 *   queueMicrotask(() => appendUsageBackground({ record }));
 */
export function appendUsageBackground(opts: UsageWriteOptions): void {
  try {
    appendUsage(opts);
  } catch {
    // best-effort — see docstring
  }
}
