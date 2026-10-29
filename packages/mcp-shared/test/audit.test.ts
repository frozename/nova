import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { appendAudit, type AuditRecord, defaultAuditDir } from "../src/audit.js";
import { toTextContent } from "../src/content.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-mcp-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendAudit", () => {
  test("writes one JSONL record per call into <server>-<date>.jsonl", () => {
    const now = (): Date => new Date("2026-04-18T12:00:00Z");
    appendAudit({ dir, server: "llamactl", tool: "foo", input: { a: 1 }, now });
    appendAudit({ dir, server: "llamactl", tool: "bar", input: { b: 2 }, dryRun: true, now });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test reads back a temp dir it created via mkdtempSync; path is test-local.
    const files = readdirSync(dir);
    expect(files).toEqual(["llamactl-2026-04-18.jsonl"]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads a file in the test's own temp dir.
    const body = readFileSync(join(dir, files[0]!), "utf8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(recs[0]?.tool).toBe("foo");
    expect(recs[0]?.dryRun).toBe(false);
    expect(recs[1]?.tool).toBe("bar");
    expect(recs[1]?.dryRun).toBe(true);
    expect(recs[1]?.input).toEqual({ b: 2 });
  });

  test("separates records by server slug", () => {
    const now = (): Date => new Date("2026-04-18T12:00:00Z");
    appendAudit({ dir, server: "llamactl", tool: "a", input: {}, now });
    appendAudit({ dir, server: "sirius", tool: "b", input: {}, now });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the test's own temp dir.
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["llamactl-2026-04-18.jsonl", "sirius-2026-04-18.jsonl"]);
  });

  test("defaultAuditDir honors LLAMACTL_MCP_AUDIT_DIR", () => {
    expect(defaultAuditDir({ LLAMACTL_MCP_AUDIT_DIR: "/custom" })).toBe("/custom");
    const withoutOverride = defaultAuditDir({ HOME: "/home/user" });
    expect(withoutOverride).toContain("/.llamactl/mcp/audit");
  });
});

function readRecords(name: string): AuditRecord[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads a file in the test's own temp dir.
  const body = readFileSync(join(dir, name), "utf8");
  return body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe("appendAudit record shaping", () => {
  test("returns exactly the record it writes, stamped by the injected clock", () => {
    const now = (): Date => new Date("2026-04-18T12:00:00Z");
    const first = appendAudit({ dir, server: "llamactl", tool: "foo", input: { a: 1 }, now });
    const second = appendAudit({
      dir,
      server: "llamactl",
      tool: "bar",
      input: { b: 2 },
      dryRun: true,
      actor: "op-1",
      result: { ok: true },
      now,
    });
    expect(first.ts).toBe("2026-04-18T12:00:00.000Z");
    expect(Object.keys(first)).toEqual(["ts", "server", "tool", "input", "dryRun"]);
    expect(first.dryRun).toBe(false);
    expect(Object.keys(second)).toEqual([
      "ts",
      "server",
      "tool",
      "input",
      "dryRun",
      "actor",
      "result",
    ]);
    expect(second.dryRun).toBe(true);
    expect(readRecords("llamactl-2026-04-18.jsonl")).toEqual([first, second]);
  });

  test("keeps a non-empty actor and leaves the key out when actor is empty or missing", () => {
    const now = (): Date => new Date("2026-04-18T12:00:00Z");
    const named = appendAudit({
      dir,
      server: "llamactl",
      tool: "a",
      input: {},
      actor: "op-1",
      now,
    });
    const empty = appendAudit({ dir, server: "llamactl", tool: "b", input: {}, actor: "", now });
    const missing = appendAudit({ dir, server: "llamactl", tool: "c", input: {}, now });
    expect(named.actor).toBe("op-1");
    expect("actor" in empty).toBe(false);
    expect("actor" in missing).toBe(false);
    const written = readRecords("llamactl-2026-04-18.jsonl");
    expect(written.map((r) => "actor" in r)).toEqual([true, false, false]);
    expect(written[0]?.actor).toBe("op-1");
  });

  test("keeps a null, 0 or false result and leaves the key out when result is undefined", () => {
    const now = (): Date => new Date("2026-04-18T12:00:00Z");
    const recs = [null, 0, false, undefined].map((result) =>
      appendAudit({ dir, server: "llamactl", tool: "r", input: {}, result, now }),
    );
    expect(recs.map((r) => "result" in r)).toEqual([true, true, true, false]);
    expect(recs.map((r) => r.result)).toEqual([null, 0, false, undefined]);
    const written = readRecords("llamactl-2026-04-18.jsonl");
    expect(written.map((r) => "result" in r)).toEqual([true, true, true, false]);
    expect(written.map((r) => r.result)).toEqual([null, 0, false, undefined]);
  });
});

describe("appendAudit day file naming", () => {
  test("zero-pads the UTC month and day in the file name", () => {
    const now = (): Date => new Date("2026-01-05T00:30:00Z");
    appendAudit({ dir, server: "llamactl", tool: "a", input: {}, now });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the test's own temp dir.
    expect(readdirSync(dir)).toEqual(["llamactl-2026-01-05.jsonl"]);
  });

  test("starts a new file when the UTC day rolls over", () => {
    const late = (): Date => new Date("2026-04-18T23:59:59Z");
    const early = (): Date => new Date("2026-04-19T00:00:01Z");
    appendAudit({ dir, server: "llamactl", tool: "late", input: {}, now: late });
    appendAudit({ dir, server: "llamactl", tool: "early", input: {}, now: early });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the test's own temp dir.
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["llamactl-2026-04-18.jsonl", "llamactl-2026-04-19.jsonl"]);
    expect(readRecords("llamactl-2026-04-18.jsonl").map((r) => r.tool)).toEqual(["late"]);
    expect(readRecords("llamactl-2026-04-19.jsonl").map((r) => r.tool)).toEqual(["early"]);
  });
});

describe("defaultAuditDir override trimming", () => {
  test("trims the override and falls back to ~/.llamactl/mcp/audit when it is blank", () => {
    const fallback = join(homedir(), ".llamactl", "mcp", "audit");
    expect(defaultAuditDir({ LLAMACTL_MCP_AUDIT_DIR: " /custom " })).toBe("/custom");
    expect(defaultAuditDir({ LLAMACTL_MCP_AUDIT_DIR: "   " })).toBe(fallback);
    expect(defaultAuditDir({ LLAMACTL_MCP_AUDIT_DIR: "" })).toBe(fallback);
    expect(defaultAuditDir({})).toBe(fallback);
  });
});

describe("toTextContent", () => {
  test("wraps JSON payload in MCP text envelope", () => {
    const env = toTextContent({ hello: "world" });
    expect(env.content).toHaveLength(1);
    expect(env.content[0]!.type).toBe("text");
    expect(JSON.parse(env.content[0]!.text)).toEqual({ hello: "world" });
  });
});
