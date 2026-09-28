import type { Readable, Writable } from "node:stream";

import { type ExecLogger, type HostEnv, type HostTimers, requireFiniteMs } from "./host.js";
import { superviseProcess } from "./process-supervisor.js";

export interface StdioAcpServerOptions {
  command: string;
  args: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  /** Optional hard ceiling on the child lifetime; omit for no watchdog. */
  watchdogMs?: number;
  /**
   * Bytes of child stderr to retain for diagnostic surfacing in error paths.
   * The captured tail is exposed via `getStderrTail()` so callers can append
   * it to error messages when a session/prompt times out or the child crashes
   * before responding.
   */
  stderrTailBytes: number;
  /** Combined per-stream output cap; absent means the child is never killed for output volume. */
  outputLimitBytes?: number;
  /** Host-owned stderr sink — invoked per chunk; the library never tees. */
  onStderrChunk?: (chunk: string) => void;
  logger?: ExecLogger;
  timers?: HostTimers;
}

export interface StdioAcpHandle {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
  exited: Promise<number | null>;
  pid?: number;
  /** Returns up to the last `stderrTailBytes` of child stderr seen so far. */
  getStderrTail: () => string;
  /**
   * Populated when the child process fails to spawn (ENOENT/EACCES) or emits
   * an `error` event before/without exiting. Callers can surface this to
   * disambiguate `exited === null` (spawn failure) from a SIGKILL exit code.
   */
  getSpawnError: () => Error | null;
}

// superviseProcess requires a finite watchdog; the largest setTimeout-safe
// value (~24.8 days) stands in for "no watchdog" on a long-lived child.
const NO_WATCHDOG = 2_147_483_000;

export function startStdioAcpServer(opts: StdioAcpServerOptions): Promise<StdioAcpHandle> {
  // The tail budget is a host input: validate it, and keep exactly one tail —
  // this function's rolling buffer. superviseProcess must not also retain one.
  const stderrTailBytes = requireFiniteMs(opts.stderrTailBytes, "stderrTailBytes", { min: 0 });
  const { onStderrChunk, logger } = opts;
  const proc = superviseProcess({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    cancelGraceMs: opts.cancelGraceMs,
    watchdogMs: opts.watchdogMs ?? NO_WATCHDOG,
    stdoutMode: "raw",
    stderrMode: "pipe",
    ...(opts.outputLimitBytes !== undefined ? { outputLimitBytes: opts.outputLimitBytes } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(opts.timers !== undefined ? { timers: opts.timers } : {}),
  });

  const tailChunks: Buffer[] = [];
  let tailBytes = 0;
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    try {
      onStderrChunk?.(buf.toString("utf8"));
    } catch {
      // A throwing host sink must not destabilize the transport.
    }
    tailChunks.push(buf);
    tailBytes += buf.length;
    while (tailBytes > stderrTailBytes && tailChunks.length > 0) {
      const head = tailChunks[0] ?? Buffer.alloc(0);
      const overflow = tailBytes - stderrTailBytes;
      if (head.length <= overflow) {
        tailChunks.shift();
        tailBytes -= head.length;
      } else {
        tailChunks[0] = head.subarray(overflow);
        tailBytes -= overflow;
      }
    }
  });

  if (proc.spawnError !== null) {
    logger?.error?.("stdio-acp-server: spawn error", {
      command: opts.command,
      message: proc.spawnError.message,
    });
  }
  void proc.exit.then((record) => {
    if (record.outcome === "spawn-error") {
      logger?.error?.("stdio-acp-server: spawn error", {
        command: opts.command,
        message: proc.spawnError?.message ?? "unknown",
      });
    }
  });

  const stdin = proc.stdin;
  const stdout = proc.stdout;
  if (stdin === undefined || stdout === undefined) {
    return Promise.reject(new Error("stdio-acp-server: child stdio not piped"));
  }
  return Promise.resolve({
    stdin,
    stdout,
    kill: () => {
      proc.cancel();
    },
    exited: proc.exit.then((record) => record.code),
    pid: proc.pid,
    getStderrTail: () => Buffer.concat(tailChunks).toString("utf8"),
    getSpawnError: () => proc.spawnError,
  });
}
