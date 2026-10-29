import { describe, expect, test } from "bun:test";

import {
  HostInputError,
  requireEnv,
  requireFiniteMs,
  requireNonEmptyString,
  requireSignal,
  requireStringArray,
} from "../src/host.ts";
import * as lib from "../src/index.ts";

/**
 * Pins the value-level host input guards in `src/host.ts`. They are the
 * fail-closed gate in front of every spawn and ACP session, so a loosened
 * check (NaN accepted as a watchdog, a non-string env entry, a zero boot
 * deadline) must fail here. Pure synchronous calls: no spawn, fs, clock,
 * timers or network.
 */

function captureHostInputError(fn: () => unknown): HostInputError | undefined {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof HostInputError) {
      return err;
    }
    throw err;
  }
  return undefined;
}

function expectRejected(fn: () => unknown, field: string, reason: string): void {
  const err = captureHostInputError(fn);
  expect(err).toBeInstanceOf(HostInputError);
  expect(err?.name).toBe("HostInputError");
  expect(err?.field).toBe(field);
  expect(err?.message).toBe(`exec-primitives: missing or invalid host input "${field}": ${reason}`);
}

describe("HostInputError", () => {
  test("carries the name, the field and the formatted message", () => {
    const err = new HostInputError("watchdogMs", "expected a finite number >= 1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HostInputError");
    expect(err.field).toBe("watchdogMs");
    expect(err.message).toBe(
      'exec-primitives: missing or invalid host input "watchdogMs": expected a finite number >= 1',
    );
  });

  test("is the same class the package entry exports", () => {
    expect(lib.HostInputError).toBe(HostInputError);
  });
});

describe("requireNonEmptyString", () => {
  test("returns a non-empty string unchanged, whitespace included", () => {
    expect(requireNonEmptyString("x", "cwd")).toBe("x");
    expect(requireNonEmptyString(" ", "cwd")).toBe(" ");
  });

  test("rejects an empty string and every non-string", () => {
    const values: unknown[] = ["", 0, null, undefined, {}];
    for (const value of values) {
      expectRejected(
        () => requireNonEmptyString(value, "spec.agent"),
        "spec.agent",
        "expected a non-empty string",
      );
    }
  });
});

describe("requireFiniteMs", () => {
  test("with the default min accepts 0 and a fraction", () => {
    expect(requireFiniteMs(0, "cancelGraceMs")).toBe(0);
    expect(requireFiniteMs(1.5, "cancelGraceMs")).toBe(1.5);
    expect(requireFiniteMs(0, "cancelGraceMs", {})).toBe(0);
  });

  test("rejects NaN, Infinity and -Infinity", () => {
    const values: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of values) {
      expectRejected(
        () => requireFiniteMs(value, "watchdogMs"),
        "watchdogMs",
        "expected a finite number >= 0",
      );
    }
  });

  test("rejects a negative number and every non-number", () => {
    const values: unknown[] = [-1, "5", undefined];
    for (const value of values) {
      expectRejected(
        () => requireFiniteMs(value, "watchdogMs"),
        "watchdogMs",
        "expected a finite number >= 0",
      );
    }
  });

  test("with min 1 accepts exactly 1", () => {
    expect(requireFiniteMs(1, "bootDeadlineMs", { min: 1 })).toBe(1);
  });

  test("with min 1 rejects 0 and 0.5 and names the min", () => {
    const values: unknown[] = [0, 0.5];
    for (const value of values) {
      expectRejected(
        () => requireFiniteMs(value, "bootDeadlineMs", { min: 1 }),
        "bootDeadlineMs",
        "expected a finite number >= 1",
      );
    }
  });
});

describe("requireEnv", () => {
  test("returns a fresh copy of a string map", () => {
    const input = { A: "1", B: "" };
    const out = requireEnv(input, "env");
    expect(out).toStrictEqual({ A: "1", B: "" });
    expect(out).not.toBe(input);
  });

  test("accepts an empty map", () => {
    expect(requireEnv({}, "env")).toStrictEqual({});
  });

  test("rejects null, an array and every non-object", () => {
    const values: unknown[] = [null, [], "str", 5, undefined];
    for (const value of values) {
      expectRejected(() => requireEnv(value, "env"), "env", "expected a string map");
    }
  });

  test("rejects a non-string entry and names its key", () => {
    expectRejected(() => requireEnv({ A: "1", B: 2 }, "env"), "env", 'entry "B" is not a string');
    expectRejected(() => requireEnv({ B: undefined }, "env"), "env", 'entry "B" is not a string');
  });
});

describe("requireStringArray", () => {
  test("returns the same array reference", () => {
    const args = ["a", ""];
    const none: string[] = [];
    expect(requireStringArray(args, "args")).toBe(args);
    expect(requireStringArray(none, "args")).toBe(none);
  });

  test("rejects a mixed array and every non-array", () => {
    const values: unknown[] = [["a", 1], "a", null, { length: 0 }, undefined];
    for (const value of values) {
      expectRejected(
        () => requireStringArray(value, "args"),
        "args",
        "expected an array of strings",
      );
    }
  });
});

describe("requireSignal", () => {
  test("returns a live and an already-aborted AbortSignal unchanged", () => {
    const live = new AbortController().signal;
    const aborted = new AbortController();
    aborted.abort();
    expect(requireSignal(live, "signal")).toBe(live);
    expect(requireSignal(aborted.signal, "signal")).toBe(aborted.signal);
  });

  test("accepts a duck-typed signal with a boolean aborted and addEventListener", () => {
    const duck = {
      aborted: false,
      addEventListener: (): void => {
        // no-op: only the method's presence is checked
      },
    };
    const returned: unknown = requireSignal(duck, "signal");
    expect(returned).toBe(duck);
  });

  test("rejects null, a plain object, a non-boolean aborted and a missing addEventListener", () => {
    const values: unknown[] = [
      null,
      {},
      {
        aborted: "no",
        addEventListener: (): void => {
          // no-op: aborted is the wrong type
        },
      },
      { aborted: false },
      undefined,
    ];
    for (const value of values) {
      expectRejected(() => requireSignal(value, "signal"), "signal", "expected an AbortSignal");
    }
  });
});
