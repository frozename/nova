export class HostInputError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`exec-primitives: missing or invalid host input "${field}": ${reason}`);
    this.name = "HostInputError";
    this.field = field;
  }
}

export interface ExecLogger {
  debug?: (message: string, fields?: Record<string, unknown>) => void;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface HostTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now?: () => number;
}

export type HostEnv = Record<string, string>;

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HostInputError(field, "expected a non-empty string");
  }
  return value;
}

export function requireFiniteMs(value: unknown, field: string, opts?: { min?: number }): number {
  const min = opts?.min ?? 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new HostInputError(field, `expected a finite number >= ${String(min)}`);
  }
  return value;
}

export function requireEnv(value: unknown, field: string): HostEnv {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostInputError(field, "expected a string map");
  }
  const out: HostEnv = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new HostInputError(field, `entry "${key}" is not a string`);
    }
    out[key] = val;
  }
  return out;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new HostInputError(field, "expected an array of strings");
  }
  return value;
}

export function requireSignal(value: unknown, field: string): AbortSignal {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as AbortSignal).aborted !== "boolean" ||
    typeof (value as AbortSignal).addEventListener !== "function"
  ) {
    throw new HostInputError(field, "expected an AbortSignal");
  }
  return value as AbortSignal;
}
