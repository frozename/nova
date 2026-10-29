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
    getStderrTail: () => "",
    getSpawnError: () => null,
  };
  return { handle, killed: () => killed };
}

interface ExitingMock {
  handle: lib.StdioAcpHandle;
  killed: () => boolean;
  /** Closes stdout the way a real exit does, then settles `exited` with `code`. */
  exit: (code: number | null) => void;
  /** Closes stdout but leaves `exited` pending, like a handle whose exit was never reported. */
  closeStdout: () => void;
}

function exitingHandle(): ExitingMock {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let killed = false;
  let settle: ((code: number | null) => void) | undefined;
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const handle: lib.StdioAcpHandle = {
    stdin,
    stdout,
    kill: () => {
      killed = true;
    },
    exited,
    getStderrTail: () => "",
    getSpawnError: () => null,
  };
  return {
    handle,
    killed: () => killed,
    exit: (code: number | null): void => {
      stdout.destroy();
      settle?.(code);
    },
    closeStdout: (): void => {
      stdout.destroy();
    },
  };
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
        ...(pooledProc.pid !== undefined ? { pid: pooledProc.pid } : {}),
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

  test("[B7] a warm entry whose process exits with code 0 leaves the pool without a warning", async () => {
    const warnings: string[] = [];
    const pool = lib.createAcpWarmPool({
      now: () => Date.now(),
      logger: {
        warn: (message: string): void => {
          warnings.push(message);
        },
      },
    });
    try {
      const mock = exitingHandle();
      pool.deposit(spec("scope-a"), { client: {}, handle: mock.handle });
      expect(pool.size()).toBe(1);
      mock.exit(0);
      await sleep(0);
      expect(pool.size()).toBe(0);
      expect(pool.diagnostics().keys).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a warm entry whose process exits non-zero leaves the pool with a warning", async () => {
    const warnings: string[] = [];
    const pool = lib.createAcpWarmPool({
      now: () => Date.now(),
      logger: {
        warn: (message: string): void => {
          warnings.push(message);
        },
      },
    });
    try {
      const mock = exitingHandle();
      pool.deposit(spec("scope-a"), { client: {}, handle: mock.handle });
      mock.exit(1);
      await sleep(0);
      expect(pool.size()).toBe(0);
      expect(warnings).toEqual(["acp-warm-pool: crashed warm entry teardown"]);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] capacity eviction keeps a live entry when another entry exited with code 0", async () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxEntries: 2, now: () => t });
    try {
      const a = exitingHandle();
      const b = exitingHandle();
      const c = exitingHandle();
      pool.deposit(spec("scope-a"), { client: {}, handle: a.handle });
      t = 1;
      pool.deposit(spec("scope-b"), { client: {}, handle: b.handle });
      b.exit(0);
      await sleep(0);
      t = 2;
      pool.deposit(spec("scope-c"), { client: {}, handle: c.handle });
      expect(a.killed()).toBe(false);
      expect(pool.has(spec("scope-a"))).toBe(true);
      expect(pool.has(spec("scope-c"))).toBe(true);
      expect(pool.size()).toBe(2);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] capacity eviction prunes an entry whose stdout closed before its exit was reported", () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxEntries: 2, now: () => t });
    try {
      const a = exitingHandle();
      const b = exitingHandle();
      const c = exitingHandle();
      pool.deposit(spec("scope-a"), { client: {}, handle: a.handle });
      t = 1;
      pool.deposit(spec("scope-b"), { client: {}, handle: b.handle });
      b.closeStdout();
      t = 2;
      pool.deposit(spec("scope-c"), { client: {}, handle: c.handle });
      expect(a.killed()).toBe(false);
      expect(b.killed()).toBe(true);
      expect(pool.has(spec("scope-a"))).toBe(true);
      expect(pool.has(spec("scope-c"))).toBe(true);
      expect(pool.size()).toBe(2);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a reused entry is retired once past maxAgeMs since its first deposit", () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxAgeMs: 100, now: () => t });
    const { handle, killed } = mockHandle();
    try {
      pool.deposit(spec("scope-a"), { client: {}, handle });
      t = 60;
      expect(pool.acquire(spec("scope-a"))).not.toBeNull();
      const again = pool.deposit(spec("scope-a"), { client: {}, handle });
      expect(again?.spawnedAt).toBe(0);
      expect(again?.lastIdleAt).toBe(60);
      t = 150;
      expect(pool.acquire(spec("scope-a"))).toBeNull();
      expect(killed()).toBe(true);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a different handle deposited later gets its own spawn time", () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxAgeMs: 100, now: () => t });
    const first = mockHandle();
    const second = mockHandle();
    try {
      pool.deposit(spec("scope-a"), { client: {}, handle: first.handle });
      t = 60;
      expect(pool.acquire(spec("scope-a"))?.handle).toBe(first.handle);
      const entry = pool.deposit(spec("scope-a"), { client: {}, handle: second.handle });
      expect(entry?.spawnedAt).toBe(60);
      t = 150;
      expect(pool.acquire(spec("scope-a"))?.handle).toBe(second.handle);
      expect(second.killed()).toBe(false);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a rejected deposit does not record a spawn time for its handle", () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxAgeMs: 100, maxEntries: 1, now: () => t });
    const pinnedSpec: lib.WarmPoolSpec = { ...spec("scope-a"), pinned: true };
    const holder = mockHandle();
    const waiting = mockHandle();
    try {
      pool.deposit(pinnedSpec, { client: {}, handle: holder.handle });
      t = 10;
      expect(
        pool.deposit(spec("scope-b"), { client: {}, handle: waiting.handle }, { onReject: "keep" }),
      ).toBeNull();
      expect(waiting.killed()).toBe(false);
      pool.evict(pinnedSpec);
      t = 50;
      const entry = pool.deposit(spec("scope-b"), { client: {}, handle: waiting.handle });
      expect(entry?.spawnedAt).toBe(50);
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a deposit whose handle already stopped is rejected and does not evict a live entry", () => {
    const pool = lib.createAcpWarmPool({ now: () => 0 });
    const a = mockHandle();
    const b = exitingHandle();
    try {
      pool.deposit(spec("scope-a"), { client: {}, handle: a.handle });
      b.closeStdout();
      const accepted = pool.deposit(spec("scope-a"), { client: {}, handle: b.handle });
      expect({
        accepted: accepted !== null,
        aKilled: a.killed(),
        bKilled: b.killed(),
        has: pool.has(spec("scope-a")),
        size: pool.size(),
      }).toEqual({ accepted: false, aKilled: false, bKilled: true, has: true, size: 1 });
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a re-deposit past maxAgeMs is rejected and does not evict a live entry", () => {
    let t = 0;
    const pool = lib.createAcpWarmPool({ maxAgeMs: 100, now: () => t });
    const h = mockHandle();
    const a = mockHandle();
    try {
      pool.deposit(spec("scope-a"), { client: {}, handle: h.handle });
      t = 10;
      expect(pool.acquire(spec("scope-a"))?.handle).toBe(h.handle);
      t = 90;
      pool.deposit(spec("scope-a"), { client: {}, handle: a.handle });
      t = 120;
      const accepted = pool.deposit(spec("scope-a"), { client: {}, handle: h.handle });
      const acquired = pool.acquire(spec("scope-a"));
      expect({
        accepted: accepted !== null,
        aKilled: a.killed(),
        hKilled: h.killed(),
        acquiredIsA: acquired?.handle === a.handle,
      }).toEqual({ accepted: false, aKilled: false, hKilled: true, acquiredIsA: true });
    } finally {
      pool.shutdown();
    }
  });

  test("[B7] a deposit whose transport is closed does not evict a live entry under another key", () => {
    const pool = lib.createAcpWarmPool({ maxEntries: 1, now: () => 0 });
    const a = mockHandle();
    const b = mockHandle();
    try {
      pool.deposit(spec("scope-a"), { client: {}, handle: a.handle });
      const closedClient: lib.AcpPoolClient = { isTransportOpen: (): boolean => false };
      const accepted = pool.deposit(spec("scope-b"), { client: closedClient, handle: b.handle });
      expect({
        accepted: accepted !== null,
        aKilled: a.killed(),
        bKilled: b.killed(),
        hasA: pool.has(spec("scope-a")),
        keys: pool.diagnostics().keys.length,
      }).toEqual({ accepted: false, aKilled: false, bKilled: true, hasA: true, keys: 1 });
    } finally {
      pool.shutdown();
    }
  });
});
