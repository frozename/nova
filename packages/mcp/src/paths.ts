import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Canonical locations of the three operator YAMLs llamactl authors
 * and the sister projects consume. Every path honors the same env
 * overrides the individual loaders in llamactl / sirius / embersynth
 * use — so a deployment that relocates DEV_STORAGE or explicitly
 * points at a specific file works uniformly across the stack.
 */

/** Trimmed env value, or `undefined` when unset/blank — so a blank
 *  override falls through to the default rather than yielding "". */
function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function base(env: NodeJS.ProcessEnv): string {
  return trimmedEnv(env["DEV_STORAGE"]) ?? join(homedir(), ".llamactl");
}

/**
 * Root the operator config files live under (DEV_STORAGE or
 * ~/.llamactl). The MCP server uses this as the containment boundary
 * for agent-supplied path overrides — a tool input that resolves
 * outside this root is an arbitrary-read attempt and is rejected.
 */
export function configBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return base(env);
}

export function defaultKubeconfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return trimmedEnv(env["LLAMACTL_CONFIG"]) ?? join(base(env), "config");
}

export function defaultSiriusProvidersPath(env: NodeJS.ProcessEnv = process.env): string {
  return trimmedEnv(env["LLAMACTL_PROVIDERS_FILE"]) ?? join(base(env), "sirius-providers.yaml");
}

export function defaultEmbersynthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return trimmedEnv(env["LLAMACTL_EMBERSYNTH_CONFIG"]) ?? join(base(env), "embersynth.yaml");
}
