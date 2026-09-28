import type { Readable, Writable } from "node:stream";

import { type ChildProcess, spawn } from "node:child_process";

import {
  type ExecLogger,
  type HostEnv,
  type HostTimers,
  requireEnv,
  requireFiniteMs,
  requireNonEmptyString,
  requireSignal,
  requireStringArray,
} from "./host.js";

export type ExitOutcome = "exited" | "cancelled" | "watchdog" | "output-limit" | "spawn-error";

export interface ExitRecord {
  outcome: ExitOutcome;
  code: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: string;
  durationMs: number;
}

export interface SupervisedProcess {
  pid: number | undefined;
  pgid: number | undefined;
  stdin: Writable | undefined;
  stdout: Readable | undefined;
  stderr: Readable | undefined;
  spawnError: Error | null;
  exit: Promise<ExitRecord>;
  kill: (signal?: NodeJS.Signals) => void;
  cancel: () => void;
}

export type SupervisorSignalReason =
  | "abort"
  | "grace-expired"
  | "watchdog"
  | "output-limit"
  | "cancel"
  | "kill";

export type SupervisorEvent =
  | { type: "spawn"; pid: number | undefined }
  | { type: "signal"; signal: NodeJS.Signals; reason: SupervisorSignalReason }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; outcome: ExitOutcome };

export interface SuperviseOptions {
  command: string;
  args: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  watchdogMs: number;
  /** Child stdin: a string is written verbatim then closed; "ignore" attaches
   * /dev/null; omitted leaves the stdio pipe open for `handle.stdin`. */
  stdin?: string;
  /** Per-stream output cap in bytes; absent means uncapped. */
  outputLimitBytes?: number;
  /** Trailing stderr bytes retained on `ExitRecord.stderrTail`. */
  stderrTailBytes?: number;
  stdoutMode?: "pipe" | "raw";
  stderrMode?: "pipe" | "raw";
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onProcessEvent?: (event: SupervisorEvent) => void;
  logger?: ExecLogger;
  timers?: HostTimers;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exit: ExitRecord;
}

export interface CapacityError {
  provider: string;
  model: string | null;
  raw: string;
}

export function detectCapacityError(stderr: string): CapacityError | null {
  if (!stderr) return null;
  const patterns: { provider: string; re: RegExp }[] = [
    { provider: "google", re: /No capacity available for model ([\w.-]+)/ },
  ];
  for (const p of patterns) {
    const m = p.re.exec(stderr);
    if (m) {
      return { provider: p.provider, model: m[1] ?? null, raw: m[0] };
    }
  }
  return null;
}

interface ArmedTimer {
  handle: unknown;
  fired: boolean;
}

function armTimer(timers: HostTimers, ms: number, fn: () => void): ArmedTimer {
  const timer: ArmedTimer = { handle: undefined, fired: false };
  timer.handle = timers.setTimeout(() => {
    timer.fired = true;
    fn();
  }, ms);
  return timer;
}

function disarmTimer(timers: HostTimers, timer: ArmedTimer | null): void {
  if (timer === null || timer.fired) return;
  timer.fired = true;
  timers.clearTimeout(timer.handle);
}

// The host logger is untrusted: a throw must never skip a group kill, stall
// the exit wait, or wedge a stream listener — every log goes through here.
function safeWarn(
  logger: ExecLogger | undefined,
  message: string,
  fields?: Record<string, unknown>,
): void {
  try {
    logger?.warn?.(message, fields);
  } catch {
    // Intentionally swallowed.
  }
}

async function waitGroupGone(pgid: number | undefined, timers: HostTimers): Promise<void> {
  if (pgid === undefined) return;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      timers.setTimeout(resolve, 10);
    });
  }
}

interface SupervisorState {
  aborted: boolean;
  watchdogFired: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: Buffer;
  stdoutCapped: boolean;
  stderrCapped: boolean;
  spawnError: Error | null;
  settled: boolean;
  watchdogTimer: ArmedTimer | null;
  cancelTimer: ArmedTimer | null;
}

interface NormalizedOpts {
  command: string;
  args: string[];
  cwd: string;
  env: HostEnv;
  signal: AbortSignal;
  cancelGraceMs: number;
  watchdogMs: number;
  stdin: string;
  outputLimitBytes: number | undefined;
  stderrTailBytes: number | undefined;
  stdoutPipe: boolean;
  stderrPipe: boolean;
  onStdoutChunk: ((chunk: Buffer) => void) | undefined;
  onStderrChunk: ((chunk: Buffer) => void) | undefined;
  onLine: ((line: string, stream: "stdout" | "stderr") => void) | undefined;
  onProcessEvent: ((event: SupervisorEvent) => void) | undefined;
  logger?: ExecLogger;
  timers: HostTimers;
  now: () => number;
}

function normalizeOptions(opts: SuperviseOptions): NormalizedOpts {
  const timers: HostTimers = {
    setTimeout:
      opts.timers?.setTimeout ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms)),
    clearTimeout:
      opts.timers?.clearTimeout ??
      ((h: unknown): void => {
        clearTimeout(h as Parameters<typeof clearTimeout>[0]);
      }),
    ...(opts.timers?.now !== undefined ? { now: opts.timers.now } : {}),
  };
  return {
    command: requireNonEmptyString(opts.command, "command"),
    args: requireStringArray(opts.args, "args"),
    cwd: requireNonEmptyString(opts.cwd, "cwd"),
    env: requireEnv(opts.env, "env"),
    signal: requireSignal(opts.signal, "signal"),
    cancelGraceMs: requireFiniteMs(opts.cancelGraceMs, "cancelGraceMs", { min: 0 }),
    watchdogMs: requireFiniteMs(opts.watchdogMs, "watchdogMs", { min: 1 }),
    stdin: opts.stdin ?? "pipe",
    outputLimitBytes:
      opts.outputLimitBytes === undefined
        ? undefined
        : requireFiniteMs(opts.outputLimitBytes, "outputLimitBytes", { min: 1 }),
    stderrTailBytes:
      opts.stderrTailBytes === undefined
        ? undefined
        : requireFiniteMs(opts.stderrTailBytes, "stderrTailBytes", { min: 0 }),
    stdoutPipe: (opts.stdoutMode ?? "pipe") === "pipe",
    stderrPipe: (opts.stderrMode ?? "pipe") === "pipe",
    onStdoutChunk: opts.onStdoutChunk,
    onStderrChunk: opts.onStderrChunk,
    onLine: opts.onLine,
    onProcessEvent: opts.onProcessEvent,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    timers,
    now: timers.now ?? ((): number => Date.now()),
  };
}

interface StreamLineState {
  pending: string;
}

function checkStreamCap(
  state: SupervisorState,
  n: NormalizedOpts,
  which: "stdout" | "stderr",
  killGroup: (sig: NodeJS.Signals, reason: SupervisorSignalReason) => void,
): void {
  if (n.outputLimitBytes === undefined) return;
  const observed = which === "stdout" ? state.stdoutBytes : state.stderrBytes;
  if (observed <= n.outputLimitBytes) return;
  if (which === "stdout") state.stdoutCapped = true;
  else state.stderrCapped = true;
  state.truncated = true;
  killGroup("SIGKILL", "output-limit");
  safeWarn(n.logger, "process-supervisor: output limit exceeded; killed group", {
    stream: which,
    limit: n.outputLimitBytes,
  });
}

function attachStreamHandler(
  stream: Readable,
  state: SupervisorState,
  n: NormalizedOpts,
  which: "stdout" | "stderr",
  lineState: StreamLineState,
  killGroup: (sig: NodeJS.Signals, reason: SupervisorSignalReason) => void,
): void {
  // Host callbacks are untrusted: a throw must never skip accounting, the
  // output cap, or the group kill — so all of those run before any callback.
  const callChunkCallback = (buf: Buffer): void => {
    const cb = which === "stdout" ? n.onStdoutChunk : n.onStderrChunk;
    if (cb === undefined) return;
    try {
      cb(buf);
    } catch (err) {
      safeWarn(n.logger, "process-supervisor: output callback threw", {
        stream: which,
        errClass: err instanceof Error ? err.name : typeof err,
      });
    }
  };
  const callLineCallback = (line: string): void => {
    if (n.onLine === undefined) return;
    try {
      n.onLine(line, which);
    } catch (err) {
      safeWarn(n.logger, "process-supervisor: line callback threw", {
        stream: which,
        errClass: err instanceof Error ? err.name : typeof err,
      });
    }
  };
  stream.on("data", (chunk: Buffer | string) => {
    if (which === "stdout" ? state.stdoutCapped : state.stderrCapped) return;
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (which === "stdout") state.stdoutBytes += buf.length;
    else state.stderrBytes += buf.length;
    if (which === "stderr" && n.stderrTailBytes !== undefined) {
      state.stderrTail = Buffer.concat([state.stderrTail, buf]);
      if (state.stderrTail.length > n.stderrTailBytes) {
        state.stderrTail = state.stderrTail.subarray(state.stderrTail.length - n.stderrTailBytes);
      }
    }
    checkStreamCap(state, n, which, killGroup);
    callChunkCallback(buf);
    if (n.onLine !== undefined) {
      lineState.pending += buf.toString("utf8");
      let idx: number;
      while ((idx = lineState.pending.indexOf("\n")) !== -1) {
        const line = lineState.pending.slice(0, idx);
        lineState.pending = lineState.pending.slice(idx + 1);
        callLineCallback(line.replace(/\r$/, ""));
      }
    }
  });
  stream.on("end", () => {
    if (n.onLine !== undefined && lineState.pending.length > 0) {
      const pending = lineState.pending;
      lineState.pending = "";
      callLineCallback(pending);
    }
  });
  stream.resume();
}

function cancelledProcess(): SupervisedProcess {
  const exit = Promise.resolve<ExitRecord>({
    outcome: "cancelled",
    code: null,
    signal: null,
    truncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrTail: "",
    durationMs: 0,
  });
  return {
    pid: undefined,
    pgid: undefined,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    spawnError: null,
    exit,
    kill: (): void => undefined,
    cancel: (): void => undefined,
  };
}

interface ExitWaitCtx {
  proc: ChildProcess;
  pgid: number | undefined;
  spawnTs: number;
  state: SupervisorState;
  n: NormalizedOpts;
  onAbort: () => void;
  emitEvent: (event: SupervisorEvent) => void;
}

function watchExit(ctx: ExitWaitCtx): Promise<ExitRecord> {
  const { proc, pgid, spawnTs, state, n, onAbort, emitEvent } = ctx;
  return new Promise<ExitRecord>((resolve) => {
    const finish = (record: Omit<ExitRecord, "durationMs" | "stderrTail">): void => {
      if (state.settled) return;
      state.settled = true;
      // A detached descendant can keep the process group alive after the
      // leader exits: keep the watchdog and abort listener armed until the
      // group is actually gone so neither supervision path is disarmed early.
      void waitGroupGone(pgid, n.timers).then(() => {
        disarmTimer(n.timers, state.watchdogTimer);
        n.signal.removeEventListener("abort", onAbort);
        disarmTimer(n.timers, state.cancelTimer);
        const full: ExitRecord = {
          ...record,
          stderrTail: state.stderrTail.toString("utf8"),
          durationMs: Math.max(0, n.now() - spawnTs),
        };
        emitEvent({
          type: "exit",
          code: full.code,
          signal: full.signal,
          outcome: full.outcome,
        });
        resolve(full);
      });
    };

    // A real ChildProcess emits "close" after "exit" once its stdio fds are
    // drained; lightweight ChildProcess-shaped doubles emit "exit" only.
    // Resolve on "close", or on "exit" once every piped stdio stream is done.
    let sawExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let sawClose = false;
    const stdioDone = (stream: unknown): boolean => {
      if (stream === null || stream === undefined) return true;
      const s = stream as Readable & { closed?: boolean };
      if (typeof s.readableEnded !== "boolean") return true;
      return s.readableEnded || s.destroyed || s.closed;
    };
    const finishFromExit = (): void => {
      if (sawExit === null) return;
      if (!sawClose && !(stdioDone(proc.stdout) && stdioDone(proc.stderr))) return;
      const outcome: ExitOutcome = state.truncated
        ? "output-limit"
        : state.watchdogFired
          ? "watchdog"
          : state.aborted
            ? "cancelled"
            : "exited";
      finish({
        outcome,
        code: sawExit.code,
        signal: sawExit.signal,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    };
    proc.once("exit", (code, exitSignal) => {
      proc.stdin?.destroy();
      sawExit = { code, signal: exitSignal };
      finishFromExit();
    });
    proc.once("error", (err) => {
      state.spawnError = err;
      finish({
        outcome: "spawn-error",
        code: null,
        signal: null,
        truncated: state.truncated,
        stdoutBytes: state.stdoutBytes,
        stderrBytes: state.stderrBytes,
      });
    });
    proc.once("close", (code, closeSignal) => {
      sawClose = true;
      sawExit ??= { code, signal: closeSignal };
      finishFromExit();
    });
    const streamDone = (): void => {
      finishFromExit();
    };
    for (const stream of [proc.stdout, proc.stderr]) {
      const emitter = stream as unknown as {
        once?: (event: string, listener: () => void) => void;
      } | null;
      emitter?.once?.("end", streamDone);
      emitter?.once?.("close", streamDone);
    }
  });
}

function wireChildStreams(
  proc: ChildProcess,
  state: SupervisorState,
  n: NormalizedOpts,
  killGroup: (sig: NodeJS.Signals, reason: SupervisorSignalReason) => void,
): void {
  const stdoutNeedsHandler =
    n.stdoutPipe ||
    n.onStdoutChunk !== undefined ||
    n.onLine !== undefined ||
    n.outputLimitBytes !== undefined;
  const stderrNeedsHandler =
    n.stderrPipe ||
    n.onStderrChunk !== undefined ||
    n.onLine !== undefined ||
    n.stderrTailBytes !== undefined ||
    n.outputLimitBytes !== undefined;
  // An 'error' emitted on a child stdio stream with no listener throws
  // synchronously from the emitter — keep a persistent listener on both.
  for (const [which, stream] of [
    ["stdout", proc.stdout],
    ["stderr", proc.stderr],
  ] as const) {
    // ChildProcess-shaped doubles may expose stdio slots without an emitter —
    // same duck-typing the stdioDone check applies below.
    if (typeof stream?.on !== "function") continue;
    stream.on("error", (err: Error) => {
      safeWarn(n.logger, "process-supervisor: child stdio stream error", {
        stream: which,
        errClass: err.name,
      });
    });
  }
  if (stdoutNeedsHandler && proc.stdout !== null) {
    attachStreamHandler(proc.stdout, state, n, "stdout", { pending: "" }, killGroup);
  }
  if (stderrNeedsHandler && proc.stderr !== null) {
    attachStreamHandler(proc.stderr, state, n, "stderr", { pending: "" }, killGroup);
  }
}

export function superviseProcess(opts: SuperviseOptions): SupervisedProcess {
  const n = normalizeOptions(opts);
  const sig: AbortSignal = n.signal;
  if (sig.aborted) {
    return cancelledProcess();
  }
  const state: SupervisorState = {
    aborted: false,
    watchdogFired: false,
    truncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrTail: Buffer.alloc(0),
    stdoutCapped: false,
    stderrCapped: false,
    spawnError: null,
    settled: false,
    watchdogTimer: null,
    cancelTimer: null,
  };

  const proc: ChildProcess = spawn(n.command, n.args, {
    cwd: n.cwd,
    env: n.env,
    stdio: [n.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
  });
  const spawnTs = n.now();
  const pgid = process.platform !== "win32" ? proc.pid : undefined;

  // A throwing host observer must never defuse a kill — signal first, emit after.
  const emitEvent = (event: SupervisorEvent): void => {
    if (n.onProcessEvent === undefined) return;
    try {
      n.onProcessEvent(event);
    } catch (err) {
      safeWarn(n.logger, "process-supervisor: onProcessEvent callback threw", {
        errClass: err instanceof Error ? err.name : typeof err,
      });
    }
  };

  const killGroup = (signal: NodeJS.Signals, reason: SupervisorSignalReason): void => {
    if (proc.pid === undefined) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // Process may already be gone.
      }
    }
    emitEvent({ type: "signal", signal, reason });
  };

  const startCancelSequence = (reason: "abort" | "cancel"): void => {
    if (state.cancelTimer !== null) return;
    killGroup("SIGTERM", reason);
    state.cancelTimer = armTimer(n.timers, n.cancelGraceMs, () => {
      killGroup("SIGKILL", "grace-expired");
    });
  };
  const onAbort = (): void => {
    state.aborted = true;
    startCancelSequence("abort");
  };

  const exit = watchExit({ proc, pgid, spawnTs, state, n, onAbort, emitEvent });
  wireChildStreams(proc, state, n, killGroup);

  state.watchdogTimer = armTimer(n.timers, n.watchdogMs, () => {
    state.watchdogFired = true;
    killGroup("SIGKILL", "watchdog");
  });
  // The watchdog is advisory supervision, not a keepalive — never hold the loop open.
  const rawHandle = state.watchdogTimer.handle;
  if (typeof rawHandle === "object" && rawHandle !== null && "unref" in rawHandle) {
    (rawHandle as { unref: () => void }).unref();
  }

  // The aborted case was handled before spawn; no host code runs between that
  // check and this registration, so a bare listener covers every later abort.
  sig.addEventListener("abort", onAbort, { once: true });

  if (n.stdin !== "pipe" && n.stdin !== "ignore" && proc.stdin !== null) {
    const sink = proc.stdin;
    sink.on("error", () => {
      // A child that died before the write lands is reported via the exit record.
    });
    sink.write(n.stdin, () => {
      sink.end();
    });
  }

  emitEvent({ type: "spawn", pid: proc.pid });

  return {
    pid: proc.pid,
    pgid,
    stdin: proc.stdin ?? undefined,
    stdout: proc.stdout ?? undefined,
    stderr: proc.stderr ?? undefined,
    get spawnError(): Error | null {
      return state.spawnError;
    },
    exit,
    kill: (signal: NodeJS.Signals = "SIGKILL"): void => {
      killGroup(signal, "kill");
    },
    cancel: (): void => {
      state.aborted = true;
      startCancelSequence("cancel");
    },
  };
}

export async function runProcess(opts: SuperviseOptions): Promise<RunProcessResult> {
  const limit = opts.outputLimitBytes;
  const proc = superviseProcess({ ...opts, stdin: opts.stdin ?? "ignore" });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutCollected = 0;
  let stderrCollected = 0;
  const collect = (chunks: Buffer[], collected: number, chunk: Buffer | string): number => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (limit === undefined) {
      chunks.push(buf);
      return collected + buf.length;
    }
    const remaining = limit - collected;
    if (remaining <= 0) return collected;
    chunks.push(buf.subarray(0, remaining));
    return collected + Math.min(buf.length, remaining);
  };
  proc.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutCollected = collect(stdoutChunks, stdoutCollected, chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderrCollected = collect(stderrChunks, stderrCollected, chunk);
  });
  const exit = await proc.exit;
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    exit,
  };
}
