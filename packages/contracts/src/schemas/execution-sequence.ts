import { z } from "zod";

import {
  type ExecutionEventV1,
  ExecutionEventV1Schema,
  type ExecutionTerminal,
} from "./execution-event.js";

/**
 * Pure checks for the ExecutionEventV1 stream invariants. Feed events
 * one at a time with `stepExecutionSequence` (then
 * `finishExecutionSequence` once the stream ends), or a whole recorded
 * stream with `validateExecutionEventSequence`. Both report the same
 * typed violations, each at the index of the offending event (or at the
 * stream length for a missing acceptance or terminal).
 */
export const ExecutionSequenceViolationCodeSchema = z.enum([
  "invalid-event",
  "before-acceptance",
  "duplicate-acceptance",
  "missing-acceptance",
  "identity-mismatch",
  "sequence-gap",
  "non-monotonic-sequence",
  "duplicate-terminal",
  "event-after-terminal",
  "missing-terminal",
  "not-started-after-content",
  "retryable-after-content",
]);
export type ExecutionSequenceViolationCode = z.infer<typeof ExecutionSequenceViolationCodeSchema>;

export interface ExecutionSequenceViolation {
  code: ExecutionSequenceViolationCode;
  index: number;
  message: string;
}

export interface ExecutionSequenceState {
  /** Events consumed so far, valid or not. */
  readonly consumed: number;
  readonly nextSequence: number;
  readonly requestId: string | undefined;
  readonly attemptId: string | undefined;
  readonly accepted: boolean;
  readonly contentEvents: number;
  readonly terminal: ExecutionTerminal | undefined;
}

export const INITIAL_EXECUTION_SEQUENCE_STATE: ExecutionSequenceState = Object.freeze({
  consumed: 0,
  nextSequence: 0,
  requestId: undefined,
  attemptId: undefined,
  accepted: false,
  contentEvents: 0,
  terminal: undefined,
});

export interface ExecutionSequenceStep {
  readonly state: ExecutionSequenceState;
  /** The parsed event, or undefined when the input failed the schema. */
  readonly event: ExecutionEventV1 | undefined;
  readonly violations: readonly ExecutionSequenceViolation[];
}

export type ExecutionSequenceValidation =
  | {
      ok: true;
      events: ExecutionEventV1[];
      terminal: ExecutionTerminal;
      violations: readonly ExecutionSequenceViolation[];
    }
  | {
      ok: false;
      events: ExecutionEventV1[];
      violations: readonly ExecutionSequenceViolation[];
    };

function violation(
  code: ExecutionSequenceViolationCode,
  index: number,
  message: string,
): ExecutionSequenceViolation {
  return { code, index, message };
}

function identityViolations(
  state: ExecutionSequenceState,
  event: ExecutionEventV1,
  index: number,
): ExecutionSequenceViolation[] {
  if (state.requestId === undefined) {
    return [];
  }
  if (event.requestId === state.requestId && event.attemptId === state.attemptId) {
    return [];
  }
  return [
    violation(
      "identity-mismatch",
      index,
      `event belongs to ${event.requestId}/${event.attemptId}, not ${state.requestId}/${String(state.attemptId)}`,
    ),
  ];
}

function sequenceViolations(
  state: ExecutionSequenceState,
  event: ExecutionEventV1,
  index: number,
): ExecutionSequenceViolation[] {
  const expected = state.nextSequence;
  if (event.sequence < expected) {
    return [
      violation(
        "non-monotonic-sequence",
        index,
        `sequence ${String(event.sequence)} after ${String(expected - 1)}`,
      ),
    ];
  }
  if (event.sequence > expected) {
    return [
      violation(
        "sequence-gap",
        index,
        `sequence ${String(event.sequence)} where ${String(expected)} was expected`,
      ),
    ];
  }
  return [];
}

function terminalViolations(
  state: ExecutionSequenceState,
  terminal: ExecutionTerminal,
  index: number,
): ExecutionSequenceViolation[] {
  if (state.contentEvents === 0) {
    return [];
  }
  const found: ExecutionSequenceViolation[] = [];
  if ((terminal.outcome === "cancelled" || terminal.outcome === "failed") && !terminal.started) {
    found.push(
      violation("not-started-after-content", index, "terminal says not started after content"),
    );
  }
  if (terminal.outcome === "failed" && terminal.error.retryable) {
    found.push(violation("retryable-after-content", index, "retryable failure after content"));
  }
  return found;
}

function typeViolations(
  state: ExecutionSequenceState,
  event: ExecutionEventV1,
  index: number,
): ExecutionSequenceViolation[] {
  if (event.type === "accepted") {
    return state.accepted
      ? [violation("duplicate-acceptance", index, "attempt was already accepted")]
      : [];
  }
  const found = state.accepted
    ? []
    : [violation("before-acceptance", index, `${event.type} before the acceptance event`)];
  if (event.type === "terminal") {
    found.push(...terminalViolations(state, event.terminal, index));
  }
  return found;
}

function advance(state: ExecutionSequenceState, event: ExecutionEventV1): ExecutionSequenceState {
  return {
    consumed: state.consumed + 1,
    nextSequence: Math.max(state.nextSequence, event.sequence + 1),
    requestId: state.requestId ?? event.requestId,
    attemptId: state.attemptId ?? event.attemptId,
    accepted: state.accepted || event.type === "accepted",
    contentEvents: state.contentEvents + (event.type === "content" ? 1 : 0),
    terminal: event.type === "terminal" ? event.terminal : undefined,
  };
}

/** Consume one raw input. Never mutates `state`. */
export function stepExecutionSequence(
  state: ExecutionSequenceState,
  input: unknown,
): ExecutionSequenceStep {
  const index = state.consumed;
  const consumedOnly = { ...state, consumed: index + 1 };
  const parsed = ExecutionEventV1Schema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    return {
      state: consumedOnly,
      event: undefined,
      violations: [violation("invalid-event", index, message)],
    };
  }
  const event = parsed.data;
  if (state.terminal !== undefined) {
    const code = event.type === "terminal" ? "duplicate-terminal" : "event-after-terminal";
    return {
      state: consumedOnly,
      event,
      violations: [
        violation(code, index, `${event.type} after the ${state.terminal.outcome} terminal`),
      ],
    };
  }
  return {
    state: advance(state, event),
    event,
    violations: [
      ...identityViolations(state, event, index),
      ...sequenceViolations(state, event, index),
      ...typeViolations(state, event, index),
    ],
  };
}

/** Violations that only show once the stream has ended. */
export function finishExecutionSequence(
  state: ExecutionSequenceState,
): ExecutionSequenceViolation[] {
  const found: ExecutionSequenceViolation[] = [];
  if (!state.accepted) {
    found.push(violation("missing-acceptance", state.consumed, "no acceptance event"));
  }
  if (state.terminal === undefined) {
    found.push(violation("missing-terminal", state.consumed, "stream ended without a terminal"));
  }
  return found;
}

export function validateExecutionEventSequence(
  inputs: readonly unknown[],
): ExecutionSequenceValidation {
  let state = INITIAL_EXECUTION_SEQUENCE_STATE;
  const events: ExecutionEventV1[] = [];
  const violations: ExecutionSequenceViolation[] = [];
  for (const input of inputs) {
    const step = stepExecutionSequence(state, input);
    state = step.state;
    if (step.event !== undefined) {
      events.push(step.event);
    }
    violations.push(...step.violations);
  }
  violations.push(...finishExecutionSequence(state));
  if (violations.length === 0 && state.terminal !== undefined) {
    return { ok: true, events, terminal: state.terminal, violations };
  }
  return { ok: false, events, violations };
}
