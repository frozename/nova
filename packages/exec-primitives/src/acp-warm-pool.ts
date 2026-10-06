import type { StdioAcpHandle } from "./stdio-acp-server.js";

import { type ExecLogger, HostInputError, requireNonEmptyString } from "./host.js";

/**
 * Identity of a warmable ACP process. Two specs that differ in agent, cwd or
 * credential scope must never share an entry — the pool key carries all
 * three, and the host-computed specHash must match on acquire or the entry is
 * torn down instead of reused.
 */
export interface WarmPoolSpec {
  agent: string;
  cwd: string;
  credentialScope: string;
  specHash: string;
  /** Per-entry idle grace; falls back to the pool default. */
  graceMs?: number;
  /**
   * Pinned entries are exempt from the idle-grace sweep (they are kept warm on
   * purpose) but still reaped once past maxAgeMs.
   */
  pinned?: boolean;
}

export function poolKeyFor(spec: WarmPoolSpec): string {
  const agent = requireNonEmptyString(spec.agent, "spec.agent");
  const cwd = requireNonEmptyString(spec.cwd, "spec.cwd");
  const scope = spec.credentialScope;
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new HostInputError(
      "spec.credentialScope",
      "pool keys are scoped by credential identity; a missing scope would share across tenants",
    );
  }
  return `${agent}\0${cwd}\0${scope}`;
}

export interface AcpPoolClient {
  isTransportOpen?: () => boolean;
}

export interface AcpWarmPoolDeposit {
  handle: StdioAcpHandle;
  client: AcpPoolClient;
  authMethods?: unknown[];
}

export interface AcpWarmPoolEntry {
  spec: WarmPoolSpec;
  handle: StdioAcpHandle;
  client: AcpPoolClient;
  authMethods?: unknown[];
  spawnedAt: number;
  lastIdleAt: number;
  pinned: boolean;
  tornDown?: boolean;
}

export type AcpWarmPoolDepositRejectAction = "kill" | "keep";

export interface AcpWarmPoolDepositOptions {
  onReject?: AcpWarmPoolDepositRejectAction;
}

export interface AcpWarmPoolDiagnostics {
  live: number;
  keys: string[];
}

export interface AcpWarmPool {
  /**
   * Take ownership of a matching live entry: it is removed from the pool and
   * returned, or null when nothing under the spec's key is usable. Stale or
   * mismatched candidates are torn down rather than shared.
   */
  acquire(spec: WarmPoolSpec): AcpWarmPoolEntry | null;
  deposit(
    spec: WarmPoolSpec,
    entry: AcpWarmPoolDeposit,
    opts?: AcpWarmPoolDepositOptions,
  ): AcpWarmPoolEntry | null;
  /** Tear down every entry under the spec's key. */
  evict(spec: WarmPoolSpec): void;
  has(spec: WarmPoolSpec): boolean;
  size(): number;
  diagnostics(): AcpWarmPoolDiagnostics;
  shutdown(): void;
}

export interface AcpWarmPoolDeps {
  now?: () => number;
  /** Sweep tick cadence. Default 60_000ms. */
  sweepIntervalMs?: number;
  /** Default idle grace when the spec does not carry one. Default 5m. */
  graceMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
  maxEntriesPerKey?: number;
  logger?: ExecLogger;
}

interface KeyedEntry {
  key: string;
  entry: AcpWarmPoolEntry;
}

class AcpWarmPoolImpl implements AcpWarmPool {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerKey: number;
  private readonly logger: ExecLogger | undefined;
  private readonly entries = new Map<string, AcpWarmPoolEntry[]>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(deps: AcpWarmPoolDeps) {
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? 5 * 60_000;
    this.maxAgeMs = deps.maxAgeMs ?? 30 * 60_000;
    this.maxEntries = deps.maxEntries ?? 3;
    this.maxEntriesPerKey = deps.maxEntriesPerKey ?? 1;
    this.logger = deps.logger;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, deps.sweepIntervalMs ?? 60_000);
    this.sweepTimer.unref();
  }

  acquire(spec: WarmPoolSpec): AcpWarmPoolEntry | null {
    if (this.closed) return null;
    const key = poolKeyFor(spec);
    const list = this.entries.get(key) ?? [];
    for (const entry of [...list]) {
      const usable =
        this.isRunning(entry) &&
        this.now() - entry.spawnedAt <= this.maxAgeMs &&
        entry.spec.specHash === spec.specHash;
      this.removeEntry(key, entry);
      if (usable) {
        entry.tornDown = false;
        return entry;
      }
      this.teardownEntry(key, entry);
    }
    return null;
  }

  deposit(
    spec: WarmPoolSpec,
    depositEntry: AcpWarmPoolDeposit,
    opts: AcpWarmPoolDepositOptions = {},
  ): AcpWarmPoolEntry | null {
    const key = poolKeyFor(spec);
    if (this.closed) {
      return rejectDeposit(depositEntry, opts);
    }
    if (!this.makeRoomForKey(key)) return rejectDeposit(depositEntry, opts);
    if (!this.makeRoomTotal()) return rejectDeposit(depositEntry, opts);

    const entry: AcpWarmPoolEntry = {
      spec,
      handle: depositEntry.handle,
      client: depositEntry.client,
      spawnedAt: this.now(),
      lastIdleAt: this.now(),
      pinned: spec.pinned === true,
      ...(depositEntry.authMethods !== undefined ? { authMethods: depositEntry.authMethods } : {}),
    };
    const updated = this.entries.get(key) ?? [];
    updated.push(entry);
    this.entries.set(key, updated);
    void entry.handle.exited.then((code) => {
      if (code !== 0 && this.entries.get(key)?.includes(entry) === true) {
        this.logger?.warn?.("acp-warm-pool: crashed warm entry teardown", {
          key,
          exitCode: code,
        });
        this.teardownEntry(key, entry);
      }
    });
    return entry;
  }

  evict(spec: WarmPoolSpec): void {
    const key = poolKeyFor(spec);
    for (const candidate of [...(this.entries.get(key) ?? [])]) {
      this.teardownEntry(key, candidate);
    }
  }

  has(spec: WarmPoolSpec): boolean {
    const key = poolKeyFor(spec);
    return (this.entries.get(key) ?? []).some((entry) => this.isRunning(entry));
  }

  size(): number {
    return this.totalEntries();
  }

  diagnostics(): AcpWarmPoolDiagnostics {
    return {
      live: this.allEntries().filter(({ entry }) => this.isRunning(entry)).length,
      keys: [...this.entries.keys()],
    };
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const [key, list] of [...this.entries]) {
      for (const entry of [...list]) this.teardownEntry(key, entry);
    }
    this.entries.clear();
  }

  private isRunning(entry: AcpWarmPoolEntry): boolean {
    const handle = entry.handle as StdioAcpHandle & {
      exitCode?: number | null;
      signalCode?: NodeJS.Signals | null;
    };
    const stdout = handle.stdout as StdioAcpHandle["stdout"] & { closed?: boolean };
    const transportOpen = entry.client.isTransportOpen;
    return (
      entry.tornDown !== true &&
      (handle.exitCode === null || handle.exitCode === undefined) &&
      (handle.signalCode === null || handle.signalCode === undefined) &&
      handle.stdin.writable &&
      Boolean(stdout) &&
      stdout.readable &&
      !stdout.destroyed &&
      !stdout.closed &&
      (typeof transportOpen !== "function" || transportOpen.call(entry.client))
    );
  }

  private removeEntry(key: string, entry: AcpWarmPoolEntry): void {
    const list = this.entries.get(key);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== entry);
    if (next.length === 0) this.entries.delete(key);
    else this.entries.set(key, next);
  }

  private teardownEntry(key: string, entry: AcpWarmPoolEntry): void {
    this.removeEntry(key, entry);
    if (entry.tornDown === true) return;
    entry.tornDown = true;
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
  }

  private allEntries(): KeyedEntry[] {
    const out: KeyedEntry[] = [];
    for (const [key, list] of this.entries) {
      for (const entry of list) out.push({ key, entry });
    }
    return out;
  }

  private idleEntriesFor(key: string): KeyedEntry[] {
    return (this.entries.get(key) ?? []).map((entry) => ({ key, entry }));
  }

  private evictableIdleEntries(): KeyedEntry[] {
    return this.allEntries().filter((candidate) => !candidate.entry.pinned);
  }

  private totalEntries(): number {
    let total = 0;
    for (const list of this.entries.values()) total += list.length;
    return total;
  }

  private oldestIdle(candidates: KeyedEntry[]): KeyedEntry | undefined {
    return candidates.sort((a, b) => a.entry.lastIdleAt - b.entry.lastIdleAt)[0];
  }

  private makeRoomForKey(key: string): boolean {
    const list = this.entries.get(key) ?? [];
    if (list.length < this.maxEntriesPerKey) return true;
    const oldest = this.oldestIdle(this.idleEntriesFor(key));
    if (!oldest) return false;
    this.teardownEntry(oldest.key, oldest.entry);
    return true;
  }

  private makeRoomTotal(): boolean {
    if (this.totalEntries() < this.maxEntries) return true;
    const oldest = this.oldestIdle(this.evictableIdleEntries());
    if (!oldest) return false;
    this.teardownEntry(oldest.key, oldest.entry);
    return true;
  }

  private sweep(): void {
    if (this.closed) return;
    for (const [key, list] of [...this.entries]) {
      for (const entry of [...list]) this.sweepEntry(key, entry);
    }
  }

  private sweepEntry(key: string, entry: AcpWarmPoolEntry): void {
    if (!this.isRunning(entry)) {
      this.teardownEntry(key, entry);
      return;
    }
    const grace = entry.spec.graceMs ?? this.graceMs;
    const idleExpired = this.now() - entry.lastIdleAt > grace;
    const aged = this.now() - entry.spawnedAt > this.maxAgeMs;
    if (entry.pinned) {
      if (aged) this.teardownEntry(key, entry);
      return;
    }
    if (idleExpired || aged) this.teardownEntry(key, entry);
  }
}

function rejectDeposit(entry: AcpWarmPoolDeposit, opts: AcpWarmPoolDepositOptions = {}): null {
  if ((opts.onReject ?? "kill") === "kill") {
    try {
      entry.handle.kill();
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function createAcpWarmPool(deps: AcpWarmPoolDeps = {}): AcpWarmPool {
  return new AcpWarmPoolImpl(deps);
}
