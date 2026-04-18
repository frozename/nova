import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Canonical locations of the three operator YAMLs llamactl authors
 * and the sister projects consume. Every path honors the same env
 * overrides the individual loaders in llamactl / sirius / embersynth
 * use — so a deployment that relocates DEV_STORAGE or explicitly
 * points at a specific file works uniformly across the stack.
 */

function base(env: NodeJS.ProcessEnv): string {
  return env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
}

export function defaultKubeconfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLAMACTL_CONFIG?.trim() || join(base(env), 'config');
}

export function defaultSiriusProvidersPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLAMACTL_PROVIDERS_FILE?.trim() || join(base(env), 'sirius-providers.yaml');
}

export function defaultEmbersynthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLAMACTL_EMBERSYNTH_CONFIG?.trim() || join(base(env), 'embersynth.yaml');
}
