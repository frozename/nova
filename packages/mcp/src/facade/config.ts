import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Facade config loader for `@nova/mcp`. Reads a YAML file at
 * `~/.llamactl/nova-mcp.yaml` (or `$NOVA_MCP_CONFIG` override) that
 * declares the downstream MCP servers the facade should connect to.
 *
 * Missing file ⇒ returns `null` (the facade boots with zero
 * downstreams and still serves its native `nova.*` tools). Malformed
 * YAML or a shape that fails Zod validation throws — the facade
 * surfaces that at boot so the operator can fix the file.
 *
 * `${VAR}` leaves inside the parsed object are interpolated from
 * `process.env` at load time. If `VAR` is unset, the literal
 * `${VAR}` stays in the value (so operators get a visible breadcrumb
 * instead of a silent empty string).
 */

const StdioSpec = z.object({
  name: z.string(),
  transport: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const HttpSpec = z.object({
  name: z.string(),
  transport: z.literal('http'),
  url: z.url(),
  token: z.string().optional(),
});

export const DownstreamSpec = z.discriminatedUnion('transport', [StdioSpec, HttpSpec]);
export type DownstreamSpec = z.infer<typeof DownstreamSpec>;

export const NovaMcpConfigV1 = z.object({
  version: z.literal(1),
  downstreams: z.array(DownstreamSpec),
});
export type NovaMcpConfigV1 = z.infer<typeof NovaMcpConfigV1>;

export interface LoadConfigOptions {
  path?: string;
}

export function defaultNovaMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOVA_MCP_CONFIG?.trim() || join(homedir(), '.llamactl', 'nova-mcp.yaml');
}

const INTERP_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolateString(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(INTERP_RE, (match, varName: string) => {
    const v = env[varName];
    return v === undefined ? match : v;
  });
}

function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return interpolateString(value, env);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, env);
    }
    return out;
  }
  return value;
}

/**
 * Load the facade config from disk. Returns `null` when the file is
 * absent. Throws when YAML parsing or schema validation fails.
 */
export function loadConfig(opts: LoadConfigOptions = {}): NovaMcpConfigV1 | null {
  const path = opts.path ?? defaultNovaMcpConfigPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const interpolated = interpolate(parsed, process.env);
  return NovaMcpConfigV1.parse(interpolated);
}
