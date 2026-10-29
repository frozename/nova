import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeCostSnapshot } from "../src/cost/snapshot.js";

/**
 * Pins two behaviours of computeCostSnapshot in `src/cost/snapshot.ts`
 * that cost-snapshot.test.ts does not reach: an omitted, zero or
 * negative `days` falls back to a 7-day window, and token or latency
 * fields that are not finite numbers count as 0 while the record still
 * counts as a request. Fixed clock, fixed file names in a fresh temp
 * dir and `pricingDir: null`: no wall clock, timers, network or
 * operator pricing dir.
 */

let dir = "";

function now(): Date {
  return new Date("2026-04-18T00:00:00Z");
}

function writeFile(name: string, records: Record<string, unknown>[]): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file under the test-owned mkdtempSync tempdir; writing canned usage JSONL
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function writeWindowFixtures(): void {
  writeFile("openai-2026-04-10.jsonl", [
    { ts: "2026-04-10T10:00:00Z", provider: "openai", model: "m", total_tokens: 999 },
  ]);
  writeFile("openai-2026-04-12.jsonl", [
    { ts: "2026-04-12T10:00:00Z", provider: "openai", model: "m", total_tokens: 7 },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nova-cost-defaults-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("computeCostSnapshot window default", () => {
  test("omitted days gives a 7-day window ending at now", () => {
    const snap = computeCostSnapshot({ dir, pricingDir: null, now });
    expect(snap.windowSince).toBe("2026-04-11T00:00:00.000Z");
    expect(snap.windowUntil).toBe("2026-04-18T00:00:00.000Z");
  });

  test("days: 0 falls back to 7 days and counts a record six days back", () => {
    writeWindowFixtures();
    const snap = computeCostSnapshot({ days: 0, dir, pricingDir: null, now });
    expect(snap.windowSince).toBe("2026-04-11T00:00:00.000Z");
    expect(snap.windowUntil).toBe("2026-04-18T00:00:00.000Z");
    expect(snap.totalRequests).toBe(1);
    expect(snap.totalTokens).toBe(7);
    expect(snap.filesScanned).toBe(1);
  });

  test("negative days falls back to 7 days", () => {
    const snap = computeCostSnapshot({ days: -3, dir, pricingDir: null, now });
    expect(snap.windowSince).toBe("2026-04-11T00:00:00.000Z");
    expect(snap.windowUntil).toBe("2026-04-18T00:00:00.000Z");
  });

  test("a positive days is used as given", () => {
    writeWindowFixtures();
    const snap = computeCostSnapshot({ days: 2, dir, pricingDir: null, now });
    expect(snap.windowSince).toBe("2026-04-16T00:00:00.000Z");
    expect(snap.windowUntil).toBe("2026-04-18T00:00:00.000Z");
    expect(snap.totalRequests).toBe(0);
    expect(snap.filesScanned).toBe(0);
  });
});

describe("computeCostSnapshot field coercion", () => {
  test("non-numeric token and latency fields count as 0 but the record still counts", () => {
    writeFile("openai-2026-04-17.jsonl", [
      {
        ts: "2026-04-17T10:00:00Z",
        provider: "openai",
        model: "m",
        prompt_tokens: 6,
        completion_tokens: 4,
        total_tokens: 10,
        latency_ms: 100,
      },
      {
        ts: "2026-04-17T11:00:00Z",
        provider: "openai",
        model: "m",
        prompt_tokens: null,
        completion_tokens: true,
        total_tokens: "40",
        latency_ms: "9",
      },
    ]);
    const snap = computeCostSnapshot({ days: 7, dir, pricingDir: null, now });
    expect(snap.totalRequests).toBe(2);
    expect(snap.totalTokens).toBe(10);
    expect(snap.byModel).toEqual([
      {
        key: "openai/m",
        requestCount: 2,
        promptTokens: 6,
        completionTokens: 4,
        totalTokens: 10,
        avgLatencyMs: 50,
        recordsMissingPricing: 2,
      },
    ]);
    expect(snap.totalEstimatedCostUsd).toBeUndefined();
    expect(snap.recordsMissingPricing).toBe(2);
    expect(snap.pricingFilesLoaded).toBe(0);
  });
});
