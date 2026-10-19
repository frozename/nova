import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

import {
  ExecutionErrorCodeSchema,
  type ExecutionEventV1,
  ExecutionEventV1Schema,
  ExecutionFinishReasonSchema,
  type ExecutionSequenceState,
  ExecutionSequenceViolationCodeSchema,
  type ExecutionTerminal,
  ExecutionTerminalSchema,
  finishExecutionSequence,
  INITIAL_EXECUTION_SEQUENCE_STATE,
  stepExecutionSequence,
  UnifiedStreamEventSchema,
  validateExecutionEventSequence,
} from "../src/index.js";

const ID = { v: 1, requestId: "req-1", attemptId: "att-1" } as const;
const UNKNOWN_USAGE = { source: "unknown" } as const;

function accepted(sequence = 0): ExecutionEventV1 {
  return { ...ID, sequence, type: "accepted", acceptedAt: "2026-10-19T10:00:00.000Z" };
}

function content(sequence: number, text = "hi"): ExecutionEventV1 {
  return {
    ...ID,
    sequence,
    type: "content",
    payload: {
      type: "chunk",
      chunk: {
        id: "chunk-1",
        object: "chat.completion.chunk",
        model: "m",
        created: 1,
        choices: [{ index: 0, delta: { content: text } }],
      },
    },
  };
}

function ended(sequence: number, terminal: ExecutionTerminal): ExecutionEventV1 {
  return { ...ID, sequence, type: "terminal", terminal };
}

const COMPLETED: Extract<ExecutionTerminal, { outcome: "completed" }> = {
  outcome: "completed",
  completion: "upstream",
  finishReason: "stop",
  model: "m",
  usage: { source: "observed", input_tokens: 3, output_tokens: 1, total_tokens: 4 },
};

const CANCELLED: ExecutionTerminal = { outcome: "cancelled", started: true, usage: UNKNOWN_USAGE };

function failed(code: string, started = true, retryable = false): unknown {
  return {
    outcome: "failed",
    started,
    error: { code, message: code, retryable },
    usage: UNKNOWN_USAGE,
  };
}

function codesOf(inputs: readonly unknown[]): { code: string; index: number }[] {
  return validateExecutionEventSequence(inputs).violations.map(({ code, index }) => ({
    code,
    index,
  }));
}

describe("ExecutionEventV1Schema", () => {
  test("parses the acceptance event", () => {
    expect(ExecutionEventV1Schema.parse(accepted())).toEqual(accepted());
  });

  test("wraps canonical Nova chunk and tool_call payloads unchanged", () => {
    const chunk = ExecutionEventV1Schema.parse(content(1));
    const toolCall = ExecutionEventV1Schema.parse({
      ...ID,
      sequence: 2,
      type: "content",
      payload: {
        type: "tool_call",
        toolCall: { id: "call-1", type: "function", function: { name: "f", arguments: "{}" } },
      },
    });
    for (const event of [chunk, toolCall]) {
      if (event.type !== "content") {
        throw new Error("expected a content event");
      }
      expect(UnifiedStreamEventSchema.parse(event.payload)).toEqual(event.payload);
    }
  });

  test("refuses done and error payloads: the terminal is the only end signal", () => {
    for (const payload of [
      { type: "done", finish_reason: "stop", completion: "upstream" },
      { type: "error", error: { message: "boom" } },
    ]) {
      expect(UnifiedStreamEventSchema.safeParse(payload).success).toBe(true);
      const event = { ...ID, sequence: 1, type: "content", payload };
      expect(ExecutionEventV1Schema.safeParse(event).success).toBe(false);
    }
  });

  test("refuses an unknown version, empty identity and invalid sequences", () => {
    for (const patch of [
      { v: 2 },
      { requestId: "" },
      { attemptId: "" },
      { sequence: -1 },
      { sequence: 1.5 },
    ]) {
      expect(ExecutionEventV1Schema.safeParse({ ...accepted(), ...patch }).success).toBe(false);
    }
  });

  test("completed requires upstream completion proof", () => {
    for (const completion of ["eof", "error", undefined]) {
      expect(ExecutionTerminalSchema.safeParse({ ...COMPLETED, completion }).success).toBe(false);
    }
  });

  test("completed requires the executed model and may name the deployment", () => {
    const { model: _model, ...withoutModel } = COMPLETED;
    expect(ExecutionTerminalSchema.safeParse(withoutModel).success).toBe(false);
    const parsed = ExecutionTerminalSchema.parse({ ...COMPLETED, deployment: "dep-1" });
    expect(parsed).toMatchObject({ model: "m", deployment: "dep-1" });
  });

  test("every terminal requires a usage observation", () => {
    for (const terminal of [COMPLETED, CANCELLED, failed("timeout")]) {
      const { usage: _usage, ...withoutUsage } = terminal as { usage: unknown };
      expect(ExecutionTerminalSchema.safeParse(withoutUsage).success).toBe(false);
    }
    for (const usage of [
      { source: "observed", input_tokens: 1 },
      { source: "estimated", output_tokens: 2 },
      { source: "unknown" },
    ]) {
      expect(ExecutionTerminalSchema.safeParse({ ...COMPLETED, usage }).success).toBe(true);
    }
  });

  test("unknown-outcome only carries unknown usage", () => {
    const terminal = { outcome: "unknown-outcome", usage: UNKNOWN_USAGE };
    expect(ExecutionTerminalSchema.safeParse(terminal).success).toBe(true);
    const observed = { ...terminal, usage: { source: "observed", input_tokens: 1 } };
    expect(ExecutionTerminalSchema.safeParse(observed).success).toBe(false);
  });

  test("failed carries a typed error code; unknown codes are refused", () => {
    expect(ExecutionTerminalSchema.safeParse(failed("timeout")).success).toBe(true);
    expect(ExecutionTerminalSchema.safeParse(failed("oops")).success).toBe(false);
    const noRetryable = failed("timeout") as { error: Record<string, unknown> };
    delete noRetryable.error["retryable"];
    expect(ExecutionTerminalSchema.safeParse(noRetryable).success).toBe(false);
  });

  test("pins the terminal vocabulary later slices map onto", () => {
    expect(ExecutionErrorCodeSchema.options).toEqual([
      "timeout",
      "output-limit",
      "stream-overflow",
      "non-zero-exit",
      "spawn-failed",
      "target-unavailable",
      "incomplete",
      "upstream-error",
      "protocol-error",
      "internal-error",
    ]);
    expect(ExecutionFinishReasonSchema.options).toEqual([
      "stop",
      "length",
      "tool_calls",
      "content_filter",
      "refused",
    ]);
    expect(ExecutionTerminalSchema.options.map((o) => o.shape.outcome.value)).toEqual([
      "completed",
      "cancelled",
      "failed",
      "unknown-outcome",
    ]);
  });

  test("not-started is expressible for cancel and for a deadline before start", () => {
    expect(ExecutionTerminalSchema.parse({ ...CANCELLED, started: false })).toMatchObject({
      started: false,
    });
    expect(ExecutionTerminalSchema.parse(failed("timeout", false))).toMatchObject({
      started: false,
    });
  });

  test("strips fields outside the contract", () => {
    const parsed = ExecutionEventV1Schema.parse({ ...accepted(), workerIncarnation: "w-9" });
    expect(parsed).not.toHaveProperty("workerIncarnation");
  });
});

describe("validateExecutionEventSequence", () => {
  test("accepts acceptance, content and one terminal and returns typed events", () => {
    const result = validateExecutionEventSequence([accepted(), content(1), ended(2, COMPLETED)]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.events.map((e) => e.type)).toEqual(["accepted", "content", "terminal"]);
    if (!result.ok) {
      throw new Error("expected ok");
    }
    expect(result.terminal).toEqual(COMPLETED);
  });

  test("accepts acceptance followed directly by the terminal", () => {
    const result = validateExecutionEventSequence([
      accepted(),
      ended(1, { ...CANCELLED, started: false }),
    ]);
    expect(result.ok).toBe(true);
  });

  test("reports an empty sequence as missing acceptance and terminal", () => {
    expect(codesOf([])).toEqual([
      { code: "missing-acceptance", index: 0 },
      { code: "missing-terminal", index: 0 },
    ]);
  });

  test("acceptance must come first, exactly once", () => {
    expect(codesOf([content(0), accepted(1), ended(2, COMPLETED)])).toEqual([
      { code: "before-acceptance", index: 0 },
    ]);
    expect(codesOf([accepted(0), accepted(1), ended(2, COMPLETED)])).toEqual([
      { code: "duplicate-acceptance", index: 1 },
    ]);
  });

  test("sequence starts at zero and increases by exactly one", () => {
    expect(codesOf([accepted(1), ended(2, COMPLETED)])).toEqual([
      { code: "sequence-gap", index: 0 },
    ]);
    expect(codesOf([accepted(0), content(2), ended(3, COMPLETED)])).toEqual([
      { code: "sequence-gap", index: 1 },
    ]);
    expect(codesOf([accepted(0), content(1), content(1), ended(2, COMPLETED)])).toEqual([
      { code: "non-monotonic-sequence", index: 2 },
    ]);
  });

  test("every event belongs to the accepted request and attempt", () => {
    const foreign = { ...content(1), attemptId: "att-2" };
    expect(codesOf([accepted(), foreign, ended(2, COMPLETED)])).toEqual([
      { code: "identity-mismatch", index: 1 },
    ]);
  });

  test("exactly one terminal, and nothing after it", () => {
    expect(codesOf([accepted(), content(1)])).toEqual([{ code: "missing-terminal", index: 2 }]);
    expect(codesOf([accepted(), ended(1, CANCELLED), ended(2, COMPLETED)])).toEqual([
      { code: "duplicate-terminal", index: 2 },
    ]);
    expect(codesOf([accepted(), ended(1, COMPLETED), content(2)])).toEqual([
      { code: "event-after-terminal", index: 2 },
    ]);
  });

  test("a not-started terminal cannot follow content", () => {
    expect(codesOf([accepted(), content(1), ended(2, { ...CANCELLED, started: false })])).toEqual([
      { code: "not-started-after-content", index: 2 },
    ]);
  });

  test("a retryable failure cannot follow content", () => {
    expect(
      codesOf([
        accepted(),
        content(1),
        { ...ID, sequence: 2, type: "terminal", terminal: failed("upstream-error", true, true) },
      ]),
    ).toEqual([{ code: "retryable-after-content", index: 2 }]);
    expect(
      codesOf([
        accepted(),
        {
          ...ID,
          sequence: 1,
          type: "terminal",
          terminal: failed("target-unavailable", false, true),
        },
      ]),
    ).toEqual([]);
  });

  test("reports invalid frames by index and never counts them as a terminal", () => {
    const bad = {
      ...ID,
      sequence: 1,
      type: "terminal",
      terminal: { ...COMPLETED, completion: "eof" },
    };
    const result = validateExecutionEventSequence([accepted(), bad]);
    expect(result.ok).toBe(false);
    expect(result.violations.map(({ code, index }) => ({ code, index }))).toEqual([
      { code: "invalid-event", index: 1 },
      { code: "missing-terminal", index: 2 },
    ]);
    expect(result.events).toHaveLength(1);
  });

  test("stepping incrementally is pure and matches whole-sequence validation", () => {
    const inputs = [accepted(), content(1), content(1), ended(2, COMPLETED), content(3)];
    let state: ExecutionSequenceState = Object.freeze(INITIAL_EXECUTION_SEQUENCE_STATE);
    const incremental = [];
    for (const input of inputs) {
      const before = structuredClone(state);
      const step = stepExecutionSequence(Object.freeze(state), input);
      expect(state).toEqual(before);
      incremental.push(...step.violations);
      state = step.state;
    }
    incremental.push(...finishExecutionSequence(state));
    expect(incremental).toEqual([...validateExecutionEventSequence(inputs).violations]);
    expect(incremental.length).toBeGreaterThan(0);
  });
});

const GoldenCaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  events: z.array(z.unknown()),
  violations: z
    .array(z.object({ code: ExecutionSequenceViolationCodeSchema, index: z.number().int() }))
    .optional(),
});
const GoldenFileSchema = z.object({
  contract: z.literal("ExecutionEventV1"),
  cases: z.array(GoldenCaseSchema).min(1),
});
type GoldenFile = z.infer<typeof GoldenFileSchema>;

function loadGolden(name: "invalid.json" | "valid.json"): GoldenFile {
  const url = new URL(`fixtures/execution-event-v1/${name}`, import.meta.url);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- A fixed fixture beside this test file, never caller input.
  const raw: unknown = JSON.parse(readFileSync(url, "utf8"));
  return GoldenFileSchema.parse(raw);
}

describe("ExecutionEventV1 golden fixtures", () => {
  const valid = loadGolden("valid.json");
  const invalid = loadGolden("invalid.json");

  test("case names are unique across both files", () => {
    const names = [...valid.cases, ...invalid.cases].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every valid case validates with no violations", () => {
    for (const c of valid.cases) {
      expect({ name: c.name, violations: codesOf(c.events) }).toEqual({
        name: c.name,
        violations: [],
      });
      expect(c.violations).toBeUndefined();
    }
  });

  test("every invalid case yields exactly its recorded violations", () => {
    for (const c of invalid.cases) {
      expect(c.violations?.length).toBeGreaterThan(0);
      expect({ name: c.name, violations: codesOf(c.events) }).toEqual({
        name: c.name,
        violations: c.violations ?? [],
      });
    }
  });

  test("valid cases cover every outcome, finish reason, error code, start state and usage source", () => {
    const terminals = valid.cases.map((c) => {
      const result = validateExecutionEventSequence(c.events);
      if (!result.ok) {
        throw new Error(`${c.name} is not valid`);
      }
      return result.terminal;
    });
    const seen = new Set<string>();
    for (const t of terminals) {
      seen.add(`outcome:${t.outcome}`);
      seen.add(`usage:${t.usage.source}`);
      if (t.outcome === "completed") {
        seen.add(`finish:${t.finishReason}`);
      }
      if (t.outcome === "failed") {
        seen.add(`code:${t.error.code}`);
        seen.add(`retryable:${String(t.error.retryable)}`);
      }
      if (t.outcome === "cancelled" || t.outcome === "failed") {
        seen.add(`started:${String(t.started)}`);
      }
    }
    const required = [
      ...ExecutionTerminalSchema.options.map((o) => `outcome:${o.shape.outcome.value}`),
      ...ExecutionFinishReasonSchema.options.map((r) => `finish:${r}`),
      ...ExecutionErrorCodeSchema.options.map((c) => `code:${c}`),
      "started:true",
      "started:false",
      "retryable:true",
      "retryable:false",
      "usage:observed",
      "usage:estimated",
      "usage:unknown",
    ];
    expect(required.filter((r) => !seen.has(r))).toEqual([]);
  });

  test("invalid cases cover every violation code", () => {
    const seen = new Set(invalid.cases.flatMap((c) => (c.violations ?? []).map((v) => v.code)));
    expect(ExecutionSequenceViolationCodeSchema.options.filter((c) => !seen.has(c))).toEqual([]);
  });
});
