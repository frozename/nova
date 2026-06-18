#!/usr/bin/env bun
/**
 * CI test gate that tolerates a known, version-independent Bun NAPI-teardown
 * panic without masking real failures.
 *
 * `bun test` can exit 133 ("panic(main thread): A C++ exception occurred / Bun
 * has crashed") at PROCESS TEARDOWN — AFTER printing a clean summary — when
 * certain native addons co-reside in one test process. A bare `bun test` exit
 * code therefore reds the CI gate even when every test passes.
 *
 * This wrapper runs `bun test`, streams its output, and gates on the REPORTED
 * failure/error counts instead of the raw exit code. It exits 0 only when the
 * run reached its summary with 0 failures AND 0 errors AND the non-zero exit is
 * the known teardown panic. A real test failure (fail > 0), a load error
 * (error > 0), or any crash BEFORE the summary (no "Ran N tests" line) still
 * fails the gate.
 *
 * Nova's current suites use no native NAPI addons, so the panic does not
 * reproduce here today; the tolerance is defensive, kept aligned with the
 * upstream gate so a future native dependency cannot silently red an otherwise
 * green run.
 */
import { spawnSync } from "node:child_process";

const res = spawnSync("bun", ["test", ...process.argv.slice(2)], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});
const stdout = res.stdout;
const stderr = res.stderr;
const raw = stdout + stderr;
// Echo the child's output so CI logs are unchanged.
process.stdout.write(stdout);
process.stderr.write(stderr);

const code = res.status ?? 1;
if (code === 0) process.exit(0);

// Strip ANSI escape sequences before parsing. The control character is built
// from its code point so the source carries no literal control byte.
// eslint-disable-next-line security/detect-non-literal-regexp -- pattern is a compile-time constant (the ANSI CSI escape); built dynamically only to keep a literal control byte out of source for no-control-regex.
const ansi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
const out = raw.replaceAll(ansi, "");
const lastNum = (re: RegExp): number | null => {
  const m = [...out.matchAll(re)].pop();
  return m ? Number(m[1]) : null;
};
const fails = lastNum(/(\d+)\s+fail\b/g);
const errors = lastNum(/(\d+)\s+error\b/g) ?? 0;
const reachedSummary = /Ran\s+\d+\s+tests?\b/.test(out);
const knownPanic = /Bun has crashed|panic\(main thread\)/.test(out);

if (reachedSummary && fails === 0 && errors === 0 && knownPanic) {
  console.error(
    `::warning:: bun test exited ${String(code)} via the known NAPI-teardown panic, but reported 0 failures / 0 errors across all suites — treating as pass. See scripts/bun-test-gate.ts.`,
  );
  process.exit(0);
}

console.error(
  `bun-test-gate: failing (exit ${String(code)}; fails=${String(fails)} errors=${String(errors)} reachedSummary=${String(reachedSummary)} knownPanic=${String(knownPanic)}).`,
);
process.exit(code);
