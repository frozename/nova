import type { PlannerToolDescriptor } from './schema.js';

/**
 * Operator-configurable allow/deny list for the planner. Config lives
 * at `~/.llamactl/planner.yaml` and is passed in already-parsed; this
 * module is pure so tests can hit it without touching disk.
 *
 * Semantics:
 *   - Patterns are glob-ish: a trailing `*` matches any suffix.
 *     Everything else is an exact name match. No regex.
 *   - `deny` wins over `allow`. A tool that matches any deny pattern
 *     is excluded regardless of allow matches. This is what operators
 *     expect — "allow llamactl.*, deny llamactl.infra.uninstall" must
 *     keep uninstall out even though it matches the allow glob.
 *   - Empty allow list = nothing is allowed. This is intentional:
 *     misconfiguration should fail closed rather than silently expose
 *     every tool. Callers that want "all tools" pass `['*']`.
 *   - Destructive-tier mutations additionally require an explicit
 *     opt-in (`allowDestructive: true`) — the allow pattern alone is
 *     not enough. Bare `'*'` does NOT grant destructive access.
 */
export interface AllowlistConfig {
  allow: string[];
  deny: string[];
  allowDestructive?: boolean;
}

function matches(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

function matchesAny(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (matches(name, p)) return true;
  }
  return false;
}

export function filterTools(
  tools: PlannerToolDescriptor[],
  config: AllowlistConfig,
): PlannerToolDescriptor[] {
  const allowDestructive = config.allowDestructive === true;
  const out: PlannerToolDescriptor[] = [];
  for (const tool of tools) {
    if (matchesAny(tool.name, config.deny)) continue;
    if (!matchesAny(tool.name, config.allow)) continue;
    if (tool.tier === 'mutation-destructive' && !allowDestructive) continue;
    out.push(tool);
  }
  return out;
}

/**
 * Defaults shipped with llamactl when the operator has not written
 * their own planner.yaml. Conservatively opens read + dry-run-safe
 * mutations across all four MCP servers; keeps destructive mutations
 * (deregister, uninstall, delete) off until the operator opts in.
 */
export const DEFAULT_ALLOWLIST: AllowlistConfig = {
  allow: [
    'llamactl.*',
    'sirius.*',
    'embersynth.*',
    'nova.*',
  ],
  deny: [
    'sirius.providers.deregister',
    'llamactl.infra.uninstall',
    'llamactl.workload.delete',
  ],
  allowDestructive: false,
};
