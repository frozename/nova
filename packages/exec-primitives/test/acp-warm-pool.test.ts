import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";
import { cleanupDir, groupExists, hostEnv, makeTmpDir, sleep } from "./helpers.ts";

function mockHandle(): { handle: lib.StdioAcpHandle; killed: () => boolean } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  const handle: lib.StdioAcpHandle = {
    stdin,
    stdout,
    kill: () => {
      killed = true;
    },
    exited: new Promise<number | null>(() => {
      // pending forever: a live mock handle
    }),
    pid: undefined,
    getStderrTail: () => "",
    getSpawnError: () => null,
  };
  return { handle, killed: () => killed };
}

function spec(scope: string, cwd = "/tmp/warm"): lib.WarmPoolSpec {
  return {
    agent: "fake-acp",
    cwd,
    credentialScope: scope,
    specHash: "spec-hash-fixed",
  };
}

describe("[B7] warm pool", () => {
  test("[B7] poolKeyFor requires a credential scope and fails closed", () => {
    const base = spec("scope-a");
    expect(() => lib.poolKeyFor(base)).not.toThrow();
    expect(() => lib.poolKeyFor({ ...base, credentialScope: "" })).toThrow(lib.HostInputError);
    expect(() => lib.poolKeyFor({ ...base, credentialScope: "  " })).toThrow(lib.HostInputError);
  });

  test("[B7] an entry pooled under credentialScope A is never reused for scope B", () => {
    const pool = lib.createAcpWarmPool({ now: () => Date.now() });
    const { handle, killed } = mockHandle();
    pool.deposit(spec("scope-a"), { client: {}, handle });
    try {
      expect(pool.acquire(spec("scope-b"))).toBeNull();
      expect(killed()).toBe(false);
      expect(pool.acquire(spec("scope-a"))).not.toBeNull();
      expect(pool.diagnostics().live).toBe(0);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] an entry pooled under cwd A is never reused for cwd B", () => {
    const pool = lib.createAcpWarmPool({ now: () => Date.now() });
    const { handle, killed } = mockHandle();
    pool.deposit(spec("scope-a", "/tmp/warm-a"), { client: {}, handle });
    try {
      expect(pool.acquire(spec("scope-a", "/tmp/warm-b"))).toBeNull();
      expect(killed()).toBe(false);
      expect(pool.acquire(spec("scope-a", "/tmp/warm-a"))).not.toBeNull();
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a specHash mismatch tears the stale entry down instead of reusing it", () => {
    const pool = lib.createAcpWarmPool({ now: () => Date.now() });
    const { handle, killed } = mockHandle();
    pool.deposit(spec("scope-a"), { client: {}, handle });
    try {
      expect(pool.acquire({ ...spec("scope-a"), specHash: "other-hash" })).toBeNull();
      expect(killed()).toBe(true);
      expect(pool.diagnostics().live).toBe(0);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] teardown kills exactly the deposited handles; a control process survives", async () => {
    const dir = makeTmpDir("pool-teardown");
    const pool = lib.createAcpWarmPool({ now: () => Date.now() });
    try {
      const pooledProc = lib.superviseProcess({
        command: "sleep",
        args: ["30"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 50,
        watchdogMs: 60_000,
      });
      const controlProc = lib.superviseProcess({
        command: "sleep",
        args: ["30"],
        cwd: dir,
        env: hostEnv(dir),
        signal: new AbortController().signal,
        cancelGraceMs: 50,
        watchdogMs: 60_000,
      });
      const pooled: lib.StdioAcpHandle = {
        stdin: pooledProc.stdin ?? new PassThrough(),
        stdout: pooledProc.stdout ?? new PassThrough(),
        kill: () => {
          pooledProc.kill("SIGKILL");
        },
        exited: pooledProc.exit.then((r) => r.code),
        pid: pooledProc.pid,
        getStderrTail: () => "",
        getSpawnError: () => null,
      };
      pool.deposit(spec("scope-a"), { client: {}, handle: pooled });
      pool.deposit(spec("scope-b"), { client: {}, handle: pooled });
      expect(pool.diagnostics().live).toBe(2);

      pool.shutdown();
      await sleep(200);
      expect(pooledProc.pid).toBeDefined();
      expect(groupExists(pooledProc.pgid)).toBe(false);
      expect(controlProc.pid).toBeDefined();
      expect(groupExists(controlProc.pgid)).toBe(true);
      controlProc.kill("SIGKILL");
      await controlProc.exit;
    } finally {
      pool.shutdown();
      cleanupDir(dir);
    }
  });

  test("[B7] createAcpWarmPool is instance state: separate pools do not share entries", () => {
    const poolA = lib.createAcpWarmPool({ now: () => Date.now() });
    const poolB = lib.createAcpWarmPool({ now: () => Date.now() });
    try {
      const { handle } = mockHandle();
      poolA.deposit(spec("scope-a"), { client: {}, handle });
      expect(poolB.acquire(spec("scope-a"))).toBeNull();
      expect(poolB.diagnostics().live).toBe(0);
      expect(poolA.diagnostics().live).toBe(1);
      expect(poolA.acquire(spec("scope-a"))).not.toBeNull();
    } finally {
      poolA.shutdown();
      poolB.shutdown();
    }
  });

  test("[B7] sweepIntervalMs is an injectable option and the sweeper evicts an expired idle entry", async () => {
    const pool = lib.createAcpWarmPool({ sweepIntervalMs: 30, now: () => Date.now() });
    try {
      const { handle, killed } = mockHandle();
      pool.deposit({ ...spec("scope-a"), graceMs: 1 }, { client: {}, handle });
      expect(pool.diagnostics().live).toBe(1);
      await sleep(300);
      expect(killed()).toBe(true);
      expect(pool.diagnostics().live).toBe(0);
    } finally {
      pool.shutdown();
    }
  });
});
