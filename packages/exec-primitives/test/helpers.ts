import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lib from "../src/index.ts";

export const FIXTURE_PATH = join(import.meta.dir, "fixtures", "fake-acp.ts");

export function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `exec-primitives-${prefix}-`));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function hostEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env["PATH"] ?? "", HOME: dir, ...extra };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Readiness handshake: true once read() contains `needle`, false after
 * `timeoutMs`. A child prints the needle after its setup (a trap install),
 * so a test never races that setup with a fixed sleep. */
export async function waitForText(
  read: () => string,
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(needle)) {
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

// bun:test types report `.rejects.X()` as void though it is async at runtime;
// capture the rejection directly so assertions stay lint-clean.
export async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

export function groupExists(pgid: number | undefined): boolean {
  if (pgid === undefined) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function markerAbsent(marker: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Tests construct the marker inside an isolated temporary directory.
  return !existsSync(marker);
}

export interface WireLine {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function readWireLog(logPath: string): WireLine[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The wire log belongs to the test harness temporary directory.
  if (!existsSync(logPath)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The wire log belongs to the test harness temporary directory.
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireLine);
}

export function requestsTo(logPath: string, method: string): WireLine[] {
  return readWireLog(logPath).filter(
    (line) => line.method === method && line.id !== undefined && line.id !== null,
  );
}

export interface FakeAcp {
  handle: Awaited<ReturnType<typeof lib.startStdioAcpServer>>;
  client: lib.StdioAcpClient;
  dir: string;
  logPath: string;
}

export async function startFakeAcp(
  prefix: string,
  extraEnv: Record<string, string> = {},
): Promise<FakeAcp> {
  const dir = makeTmpDir(prefix);
  const logPath = join(dir, "wire.log");
  const env = hostEnv(dir, { FAKE_ACP_LOG: logPath, ...extraEnv });
  const handle = await lib.startStdioAcpServer({
    command: "bun",
    args: [FIXTURE_PATH],
    cwd: dir,
    env,
    cancelGraceMs: 300,
    signal: new AbortController().signal,
    stderrTailBytes: 8192,
  });
  const client = new lib.StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });
  return { handle, client, dir, logPath };
}

export async function stopFakeAcp(fake: FakeAcp): Promise<void> {
  fake.handle.kill();
  await fake.handle.exited;
  cleanupDir(fake.dir);
}
