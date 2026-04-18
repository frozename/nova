import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Append-only JSONL audit sink. Every mutation tool emits one record
 * per invocation so operators can reconstruct "what did the agent do
 * on my fleet" after the fact. Tool servers pass their own `server`
 * slug so llamactl / sirius / embersynth records stay in separate
 * files.
 *
 * Storage shape:
 *   ~/.llamactl/mcp/audit/<server>-<YYYY-MM-DD>.jsonl
 * Env override: `LLAMACTL_MCP_AUDIT_DIR`.
 *
 * Each record:
 *   { ts, server, tool, input, dryRun, actor?, result? }
 */

export interface AuditRecord {
  ts: string;
  server: string;
  tool: string;
  input: unknown;
  dryRun: boolean;
  actor?: string;
  result?: unknown;
}

export interface AuditOptions {
  server: string;
  tool: string;
  input: unknown;
  dryRun?: boolean;
  actor?: string;
  result?: unknown;
  /** Override the audit directory (tests, non-default deployments). */
  dir?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export function defaultAuditDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_MCP_AUDIT_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.llamactl', 'mcp', 'audit');
}

function auditFilePath(dir: string, server: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return join(dir, `${server}-${y}-${m}-${d}.jsonl`);
}

export function appendAudit(opts: AuditOptions): AuditRecord {
  const now = (opts.now ?? (() => new Date()))();
  const dir = opts.dir ?? defaultAuditDir();
  const record: AuditRecord = {
    ts: now.toISOString(),
    server: opts.server,
    tool: opts.tool,
    input: opts.input,
    dryRun: opts.dryRun ?? false,
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.result !== undefined ? { result: opts.result } : {}),
  };
  const file = auditFilePath(dir, opts.server, now);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}
