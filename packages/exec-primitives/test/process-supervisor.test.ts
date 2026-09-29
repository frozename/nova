import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import * as lib from "../src/index.ts";
import {
  catchRejection,
  cleanupDir,
  groupExists,
  hostEnv,
  makeTmpDir,
  markerAbsent,
  readWireLog,
  requestsTo,
  sleep,
  startFakeAcp,
  stopFakeAcp,
  waitForText,
} from "./helpers.ts";

describe("[B3] env boundary", () => {
  test("[B3] runProcess passes the host env verbatim and leaks nothing", async () => {
    process.env.EXEC_PRIMITIVES_ENV_LEAK = "secret";
    const dir = makeTmpDir("env");
    try {
      const result = await lib.runProcess({
        command: "sh",
        args: ["-c", "env"],
        cwd: dir,
        env: hostEnv(dir, { MARK: "1" }),
        signal: new AbortController().signal,
        cancelGraceMs: 200,
        watchdogMs: 10_000,
      });
      expect(result.exit.outcome).toBe("exited");
      expect(result.stdout).toContain("MARK=1");
      expect(result.stdout).toContain(`HOME=${dir}`);
      expect(result.stdout).not.toContain("EXEC_PRIMITIVES_ENV_LEAK");
    } finally {
      delete process.env.EXEC_PRIMITIVES_ENV_LEAK;
      cleanupDir(dir);
    }
  });

  test("[B3] startStdioAcpServer child sees exactly the host env keys", async () => {
    const fake = await startFakeAcp("envkeys", { FAKE_ACP_ECHO_ENV: "1" });
    try {
      const result = (await fake.client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "probe", version: "0.0.0" },
        clientCapabilities: {},
      })) as { _meta?: { envKeys?: string[] } };
      expect(result._meta?.envKeys).toEqual(["FAKE_ACP_ECHO_ENV", "FAKE_ACP_LOG", "HOME", "PATH"]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B3] a missing env throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("env-missing");
    const marker = join(dir, "spawned");
    try {
      const err = await catchRejection(
        lib.runProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.runProcess>[0]),
      );
      expect(err).toBeInstanceOf(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("[B3] cwd boundary", () => {
  test("[B3] cwd is required and reaches the child verbatim", async () => {
    const dir = makeTmpDir("cwd");
    try {
      const result = await lib.runProcess({
        command: "sh",
        args: ["-c", "pwd -P"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 200,
        watchdogMs: 10_000,
      });
      expect(result.stdout.trim()).toBe(realpathSync(dir));
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B3] startStdioAcpServer without a cwd throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("server-cwd-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.startStdioAcpServer({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
          stderrTailBytes: 1024,
        } as Parameters<typeof lib.startStdioAcpServer>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B3] a missing cwd throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("cwd-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("[B4] cancel grace", () => {
  for (const cancelGraceMs of [300, 2500] as const) {
    test(`[B4] SIGKILL lands inside (graceMs, graceMs+1500) at cancelGraceMs=${String(cancelGraceMs)}`, async () => {
      process.env.HOST_CANCEL_GRACE_S = "60";
      const dir = makeTmpDir("grace");
      const ac = new AbortController();
      let out = "";
      try {
        const proc = lib.superviseProcess({
          command: "sh",
          // READY follows the trap: the abort never races its install.
          args: ["-c", 'trap "" TERM; echo READY; while :; do sleep 1; done'],
          cwd: dir,
          env: hostEnv(dir),
          signal: ac.signal,
          cancelGraceMs,
          watchdogMs: 30_000,
          onStdoutChunk: (chunk) => {
            out += chunk.toString("utf8");
          },
        });
        const ready = await waitForText(() => out, "READY", 2_000);
        if (!ready) ac.abort();
        expect(ready).toBe(true);
        expect(groupExists(proc.pgid)).toBe(true);

        const t0 = Date.now();
        ac.abort();
        await sleep(cancelGraceMs - 150);
        expect(groupExists(proc.pgid)).toBe(true);

        const exit = await proc.exit;
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(cancelGraceMs + 1500);
        expect(exit.outcome).toBe("cancelled");
        expect(exit.signal).toBe("SIGKILL");
        expect(groupExists(proc.pgid)).toBe(false);
      } finally {
        delete process.env.HOST_CANCEL_GRACE_S;
        cleanupDir(dir);
      }
    });
  }
});

describe("[B4] watchdog", () => {
  for (const watchdogMs of [400, 2500] as const) {
    test(`[B4] watchdog fires inside (watchdogMs, watchdogMs+1500) at watchdogMs=${String(watchdogMs)}`, async () => {
      process.env.HOST_DISPATCH_TIMEOUT_S = "60";
      const dir = makeTmpDir("watchdog");
      try {
        const t0 = Date.now();
        const proc = lib.superviseProcess({
          command: "sleep",
          args: ["30"],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs,
        });
        await sleep(50);
        expect(groupExists(proc.pgid)).toBe(true);
        await sleep(watchdogMs - 150 - 50);
        expect(groupExists(proc.pgid)).toBe(true);

        const exit = await proc.exit;
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(watchdogMs + 1500);
        expect(elapsed).toBeGreaterThanOrEqual(watchdogMs - 150);
        expect(exit.outcome).toBe("watchdog");
        expect(groupExists(proc.pgid)).toBe(false);
      } finally {
        delete process.env.HOST_DISPATCH_TIMEOUT_S;
        cleanupDir(dir);
      }
    });
  }
});

describe("[B10] required host inputs", () => {
  test("[B10] missing cancelGraceMs throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("grace-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B10] missing watchdogMs throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("watchdog-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });

  test("[B10] missing signal throws HostInputError before spawn", async () => {
    const dir = makeTmpDir("signal-missing");
    const marker = join(dir, "spawned");
    try {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: ["-c", `touch ${marker}`],
          cwd: dir,
          env: hostEnv(dir),
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
      await sleep(300);
      expect(markerAbsent(marker)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

test("[B10] cancel resolves the exit record only after the whole group is gone", async () => {
  const dir = makeTmpDir("group-gone");
  const ac = new AbortController();
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      // The descendant detaches its stdio: the leader's pipes EOF at leader
      // exit, so only the group-gone wait (not stream EOF) can delay exit.
      // READY follows both traps (the descendant's is installed last).
      args: [
        "-c",
        'trap "exit 0" TERM; (trap "" TERM; echo READY; exec sleep 30 >/dev/null 2>&1 </dev/null) & wait',
      ],
      cwd: dir,
      env: hostEnv(dir),
      signal: ac.signal,
      cancelGraceMs: 300,
      watchdogMs: 30_000,
    });

    let out = "";
    let stdoutEof = false;
    const stdoutDrained = (async (): Promise<void> => {
      for await (const chunk of proc.stdout ?? []) {
        out += String(chunk);
      }
      stdoutEof = true;
    })();
    const ready = await waitForText(() => out, "READY", 2_000);
    if (!ready) ac.abort();
    expect(ready).toBe(true);
    expect(groupExists(proc.pgid)).toBe(true);

    const t0 = Date.now();
    ac.abort();
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;

    expect(exit.outcome).toBe("cancelled");
    // SIGTERM kills the leader; the TERM-immune detached descendant holds the
    // group until the grace expires — exit cannot resolve before ~graceMs.
    expect(elapsed).toBeGreaterThanOrEqual(300 - 50);
    expect(elapsed).toBeLessThan(300 + 1500);
    await stdoutDrained;
    expect(stdoutEof).toBe(true);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] cancel delivers SIGTERM before escalating to SIGKILL", async () => {
  const dir = makeTmpDir("term-first");
  const ac = new AbortController();
  let stdout = "";
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'trap "echo TERM-SEEN; exit 0" TERM; echo READY; while :; do sleep 1; done'],
      cwd: dir,
      env: hostEnv(dir),
      signal: ac.signal,
      cancelGraceMs: 2_000,
      watchdogMs: 30_000,
      onStdoutChunk: (chunk) => {
        stdout += chunk.toString("utf8");
      },
    });
    const ready = await waitForText(() => stdout, "READY", 2_000);
    ac.abort();
    expect(ready).toBe(true);
    const exit = await proc.exit;
    expect(exit.outcome).toBe("cancelled");
    expect(stdout).toContain("TERM-SEEN");
    expect(exit.signal).not.toBe("SIGKILL");
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] outputLimitBytes kills the group and marks the record truncated", async () => {
  const dir = makeTmpDir("cap");
  let maxChunk = 0;
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      // Delay the producer so the group must still exist before any output:
      // the cap can only trip mid-stream, never before spawn.
      args: ["-c", 'sleep 0.2; head -c 1000000 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
      onStdoutChunk: (chunk) => {
        if (chunk.length > maxChunk) maxChunk = chunk.length;
      },
    });
    await sleep(50);
    expect(groupExists(proc.pgid)).toBe(true);
    const exit = await proc.exit;
    const overshoot = exit.stdoutBytes - 65_536;
    // Measured marker — the evidence writer quotes this line from the gate log.
    console.error(`t7-overshoot=${String(overshoot)}`);
    expect(exit.outcome).toBe("output-limit");
    expect(exit.truncated).toBe(true);
    expect(overshoot).toBeGreaterThan(0);
    expect(maxChunk).toBeGreaterThan(0);
    // The cap trips on the chunk that crosses it: overshoot <= that chunk.
    expect(overshoot).toBeLessThanOrEqual(maxChunk);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] output under the cap exits normally and is not truncated", async () => {
  const dir = makeTmpDir("cap-ok");
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'head -c 1024 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
    });
    const exit = await proc.exit;
    expect(exit.outcome).toBe("exited");
    expect(exit.truncated).toBe(false);
    expect(exit.stdoutBytes).toBe(1024);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] injected timers are fully disarmed by the time exit resolves on every outcome", async () => {
  const dir = makeTmpDir("timers");
  try {
    for (const scenario of [
      "exited",
      "cancelled",
      "watchdog",
      "output-limit",
      "spawn-error",
    ] as const) {
      let armed = 0;
      const timers = {
        setTimeout: (fn: () => void, ms: number): unknown => {
          armed += 1;
          return setTimeout(() => {
            armed -= 1;
            fn();
          }, ms);
        },
        clearTimeout: (handle: unknown): void => {
          clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
          armed -= 1;
        },
      };
      const ac = new AbortController();
      const base = {
        cwd: dir,
        env: hostEnv(dir),
        signal: ac.signal,
        cancelGraceMs: 100,
        watchdogMs: 10_000,
        timers,
      };
      let exit: lib.ExitRecord;
      if (scenario === "exited") {
        exit = await lib.superviseProcess({ ...base, command: "sh", args: ["-c", "echo hi"] }).exit;
      } else if (scenario === "cancelled") {
        const proc = lib.superviseProcess({ ...base, command: "sleep", args: ["30"] });
        ac.abort();
        exit = await proc.exit;
      } else if (scenario === "watchdog") {
        exit = await lib.superviseProcess({
          ...base,
          command: "sleep",
          args: ["30"],
          watchdogMs: 150,
        }).exit;
      } else if (scenario === "output-limit") {
        exit = await lib.superviseProcess({
          ...base,
          command: "sh",
          args: ["-c", 'head -c 500000 /dev/zero | tr "\\0" b'],
          outputLimitBytes: 4096,
        }).exit;
      } else {
        exit = await lib.superviseProcess({
          ...base,
          command: "/nonexistent/exec-primitives-probe",
          args: [],
        }).exit;
      }
      expect(exit.outcome).toBe(scenario);
      expect(armed).toBe(0);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] runProcess resolves on non-zero exit without throwing", async () => {
  const dir = makeTmpDir("nonzero");
  try {
    const result = await lib.runProcess({
      command: "sh",
      args: ["-c", "echo out; echo err 1>&2; exit 7"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
    });
    expect(result.exit.outcome).toBe("exited");
    expect(result.exit.code).toBe(7);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a pre-aborted signal returns cancelled without spawning", async () => {
  const dir = makeTmpDir("pre-abort");
  const marker = join(dir, "spawned");
  const ac = new AbortController();
  ac.abort();
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", `touch ${marker}`],
      cwd: dir,
      env: hostEnv(dir),
      signal: ac.signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
    });
    expect(proc.pid).toBeUndefined();
    const exit = await proc.exit;
    expect(exit.outcome).toBe("cancelled");
    await sleep(200);
    expect(markerAbsent(marker)).toBe(true);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a stdin string is written verbatim and the pipe is closed", async () => {
  const dir = makeTmpDir("stdin-content");
  try {
    const result = await lib.runProcess({
      command: "sh",
      args: ["-c", "cat"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
      stdin: "line-one\nline-two\n",
    });
    expect(result.exit.outcome).toBe("exited");
    expect(result.stdout).toBe("line-one\nline-two\n");
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] onLine emits complete lines and the raw stdout reader still returns", async () => {
  const dir = makeTmpDir("lines");
  const lines: string[] = [];
  let chunkBytes = 0;
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'printf "one\\ntwo\\n"; printf "partial"'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
      stdoutMode: "raw",
      onLine: (line, stream) => {
        if (stream === "stdout") lines.push(line);
      },
    });
    for await (const chunk of proc.stdout ?? []) {
      chunkBytes += (chunk as Buffer).length;
    }
    const exit = await proc.exit;
    expect(exit.outcome).toBe("exited");
    expect(lines).toEqual(["one", "two", "partial"]);
    expect(exit.stdoutBytes).toBe(chunkBytes);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] onProcessEvent reports spawn and exit and stderrTailBytes lands on the record", async () => {
  const dir = makeTmpDir("events");
  const events: lib.SupervisorEvent[] = [];
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", "echo head-tail-marker 1>&2; echo out"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
      stderrTailBytes: 64,
      onProcessEvent: (event) => {
        events.push(event);
      },
    });
    const exit = await proc.exit;
    expect(exit.outcome).toBe("exited");
    expect(exit.stderrTail).toContain("head-tail-marker");
    const spawn = events.find(
      (e): e is Extract<lib.SupervisorEvent, { type: "spawn" }> => e.type === "spawn",
    );
    const done = events.find(
      (e): e is Extract<lib.SupervisorEvent, { type: "exit" }> => e.type === "exit",
    );
    expect(spawn?.pid).toBe(proc.pid);
    expect(done?.outcome).toBe("exited");
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] the wire log of a real ACP session round-trips through superviseProcess pipes", async () => {
  const fake = await startFakeAcp("wire");
  try {
    const result = (await fake.client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "probe", version: "0.0.0" },
      clientCapabilities: {},
    })) as { authMethods?: unknown[] };
    expect(result.authMethods).toEqual([{ id: "env", type: "env_var" }]);
    const requests = requestsTo(fake.logPath, "initialize");
    expect(requests).toHaveLength(1);
    expect(readWireLog(fake.logPath).length).toBeGreaterThanOrEqual(2);
  } finally {
    await stopFakeAcp(fake);
  }
});

test("[B10] a leader exit with a detached descendant still resolves under the watchdog", async () => {
  const dir = makeTmpDir("leader-detached");
  try {
    const t0 = Date.now();
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", "sleep 30 >/dev/null 2>&1 </dev/null & exit 0"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 500,
    });
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;
    // The leader exited 0 but the detached sleep keeps the process group
    // alive; the watchdog stays armed until the group is gone and SIGKILLs it.
    expect(elapsed).toBeLessThan(2_000);
    expect(exit.outcome).toBe("exited");
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] an abort landing after the leader exits still reaches the detached group", async () => {
  const dir = makeTmpDir("abort-late");
  const ac = new AbortController();
  try {
    const t0 = Date.now();
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", "sleep 30 >/dev/null 2>&1 </dev/null & exit 0"],
      cwd: dir,
      env: hostEnv(dir),
      signal: ac.signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
    });
    await sleep(150);
    ac.abort();
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2_000);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a throwing onProcessEvent observer cannot defuse the watchdog and exit still settles", async () => {
  const dir = makeTmpDir("observer-throws");
  try {
    const t0 = Date.now();
    const proc = lib.superviseProcess({
      command: "sleep",
      args: ["30"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 500,
      onProcessEvent: () => {
        throw new Error("observer exploded");
      },
    });
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;
    expect(exit.outcome).toBe("watchdog");
    expect(elapsed).toBeLessThan(500 + 1500);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a throwing onStdoutChunk neither wedges exit nor skips the output cap", async () => {
  const dir = makeTmpDir("chunk-throws");
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'head -c 1000000 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
      onStdoutChunk: () => {
        throw new Error("chunk sink exploded");
      },
    });
    const exit = await proc.exit;
    expect(exit.outcome).toBe("output-limit");
    expect(exit.truncated).toBe(true);
    expect(exit.stdoutBytes).toBeGreaterThan(65_536);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a throwing logger.warn cannot defuse the output-limit kill and exit still settles", async () => {
  const dir = makeTmpDir("logger-throws-cap");
  try {
    const t0 = Date.now();
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", 'head -c 1000000 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
      logger: {
        warn: () => {
          throw new Error("logger exploded");
        },
      },
    });
    const exit = await proc.exit;
    const elapsed = Date.now() - t0;
    expect(exit.outcome).toBe("output-limit");
    expect(exit.truncated).toBe(true);
    expect(elapsed).toBeLessThan(1_500);
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] a throwing logger.warn plus a throwing onProcessEvent still settles exit", async () => {
  const dir = makeTmpDir("logger-observer-throw");
  try {
    const proc = lib.superviseProcess({
      command: "sh",
      args: ["-c", "echo done"],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
      onProcessEvent: () => {
        throw new Error("observer exploded");
      },
      logger: {
        warn: () => {
          throw new Error("logger exploded");
        },
      },
    });
    const exit = await proc.exit;
    expect(exit.outcome).toBe("exited");
    expect(groupExists(proc.pgid)).toBe(false);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] args must be a string array — undefined and non-string entries throw before spawn", async () => {
  const dir = makeTmpDir("args");
  const marker = join(dir, "spawned");
  try {
    for (const bad of [undefined, [1, 2], "sh"] as unknown[]) {
      expect(() =>
        lib.superviseProcess({
          command: "sh",
          args: bad,
          cwd: dir,
          env: hostEnv(dir),
          signal: new AbortController().signal,
          cancelGraceMs: 200,
          watchdogMs: 10_000,
        } as unknown as Parameters<typeof lib.superviseProcess>[0]),
      ).toThrow(lib.HostInputError);
    }
    await sleep(300);
    expect(markerAbsent(marker)).toBe(true);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] runProcess stops collecting each stream at outputLimitBytes", async () => {
  const dir = makeTmpDir("run-cap");
  try {
    const result = await lib.runProcess({
      command: "sh",
      args: ["-c", 'head -c 524288 /dev/zero | tr "\\0" a'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 30_000,
      outputLimitBytes: 65_536,
    });
    expect(result.exit.outcome).toBe("output-limit");
    expect(result.stdout.length).toBeLessThanOrEqual(65_536);
  } finally {
    cleanupDir(dir);
  }
});

test("[B10] startStdioAcpServer requires stderrTailBytes and keeps one bounded tail", async () => {
  const dir = makeTmpDir("tail-input");
  try {
    expect(() =>
      lib.startStdioAcpServer({
        command: "sh",
        args: ["-c", "true"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 200,
      } as unknown as Parameters<typeof lib.startStdioAcpServer>[0]),
    ).toThrow(lib.HostInputError);

    const handle = await lib.startStdioAcpServer({
      command: "sh",
      args: ["-c", 'head -c 200 /dev/zero | tr "\\0" "t" 1>&2; sleep 0.2'],
      cwd: dir,
      env: hostEnv(dir),
      signal: new AbortController().signal,
      cancelGraceMs: 200,
      watchdogMs: 10_000,
      stderrTailBytes: 32,
    });
    await sleep(400);
    const tail = handle.getStderrTail();
    expect(tail).toBe("t".repeat(32));
    handle.kill();
    await handle.exited;
  } finally {
    cleanupDir(dir);
  }
});
