import { z } from "zod";

import {
  StreamCompletionSchema,
  UnifiedStreamChunkEventSchema,
  UnifiedStreamToolCallEventSchema,
} from "./stream.js";
import { UsageObservationV1Schema } from "./usage.js";

/**
 * ExecutionEventV1 — one accepted execution attempt as an ordered event
 * stream. It wraps Nova's canonical stream payloads with the identity,
 * ordering, acceptance and terminal evidence a caller needs to tell a
 * real completion from a lost or failed one. Nova is its only definer;
 * executors and gateways map their own reasons onto this vocabulary and
 * never extend it locally.
 *
 * A valid attempt is `accepted`, then zero or more `content`, then
 * exactly one `terminal` (checked by `validateExecutionEventSequence`):
 *  - every event carries the same `requestId`/`attemptId`;
 *  - `sequence` is 0 on `accepted` and grows by exactly 1, so a dropped
 *    or replayed frame is detectable;
 *  - nothing follows the terminal; an error is never followed by a
 *    success-shaped end, and late output is a violation, not content.
 *
 * The terminal is either source-completion proof (`completed`, which
 * requires `completion: "upstream"` — a closed socket or a synthesized
 * `[DONE]` is never proof) or a typed non-success (`cancelled`,
 * `failed` with a code, `unknown-outcome`). Usage is always present and
 * says `unknown` when nothing was observed.
 */

/**
 * Content is the canonical Nova chunk or client-owned tool call. Nova's
 * `done`/`error` stream events are deliberately absent: an attempt ends
 * only through its terminal, so no stream can show an error and then a
 * success-parseable done.
 */
export const ExecutionContentPayloadSchema = z.discriminatedUnion("type", [
  UnifiedStreamChunkEventSchema,
  UnifiedStreamToolCallEventSchema,
]);
export type ExecutionContentPayload = z.infer<typeof ExecutionContentPayloadSchema>;

/**
 * Why a source completed. Nova's chat finish reasons without `error`
 * (an error is never a completion) plus `refused`, for sources that
 * report a refusal distinctly from provider content filtering.
 */
export const ExecutionFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "refused",
]);
export type ExecutionFinishReason = z.infer<typeof ExecutionFinishReasonSchema>;

/**
 * Typed reasons for a `failed` terminal after acceptance. Refusals
 * before acceptance belong to the caller's submit protocol, not here.
 *  - 'timeout': the deadline or watchdog fired.
 *  - 'output-limit': the host's output cap was reached and the source
 *    was stopped; partial output is never a success.
 *  - 'stream-overflow': a frame or queued-byte cap toward a slow
 *    consumer was exceeded; the stream ended and upstream was cancelled.
 *  - 'non-zero-exit': the executed process exited unsuccessfully.
 *  - 'spawn-failed': the process could not be started.
 *  - 'target-unavailable': the target stopped being executable after
 *    acceptance.
 *  - 'incomplete': the source ended (EOF, exit, transport close) without
 *    its completion signal.
 *  - 'upstream-error': the source reported a failure.
 *  - 'protocol-error': the source broke its wire protocol.
 *  - 'internal-error': the executor itself failed.
 */
export const ExecutionErrorCodeSchema = z.enum([
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
export type ExecutionErrorCode = z.infer<typeof ExecutionErrorCodeSchema>;

const executedBy = {
  /** The model that actually executed, never the requested alias. */
  model: z.string().min(1),
  /** Opaque id of the deployment that executed it, when the executor has one. */
  deployment: z.string().min(1).optional(),
};

/**
 * `started: false` means no execution work began after acceptance (no
 * engine request, no process), so the attempt had no side effect and
 * emitted no content.
 */
const started = z.boolean();

export const ExecutionTerminalSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("completed"),
    completion: StreamCompletionSchema.extract(["upstream"]),
    finishReason: ExecutionFinishReasonSchema,
    ...executedBy,
    usage: UsageObservationV1Schema,
  }),
  z.object({
    outcome: z.literal("cancelled"),
    started,
    model: executedBy.model.optional(),
    deployment: executedBy.deployment,
    usage: UsageObservationV1Schema,
  }),
  z.object({
    outcome: z.literal("failed"),
    started,
    error: z.object({
      code: ExecutionErrorCodeSchema,
      message: z.string(),
      /**
       * The executor vouches that a new attempt cannot duplicate any
       * effect of this one. Never true once content was emitted.
       */
      retryable: z.boolean(),
    }),
    model: executedBy.model.optional(),
    deployment: executedBy.deployment,
    usage: UsageObservationV1Schema,
  }),
  /**
   * The caller lost track of an accepted attempt (transport loss, a
   * status that cannot be resolved). The attempt may have run, so this
   * is never a replay signal, and its usage can only be unknown.
   */
  z.object({
    outcome: z.literal("unknown-outcome"),
    message: z.string().optional(),
    usage: UsageObservationV1Schema.refine((usage) => usage.source === "unknown", {
      message: "unknown-outcome usage must be source 'unknown'",
    }),
  }),
]);
export type ExecutionTerminal = z.infer<typeof ExecutionTerminalSchema>;

const envelope = {
  v: z.literal(1),
  requestId: z.string().min(1),
  attemptId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
};

export const ExecutionAcceptedEventSchema = z.object({
  ...envelope,
  type: z.literal("accepted"),
  acceptedAt: z.iso.datetime({ offset: true }),
});
export type ExecutionAcceptedEvent = z.infer<typeof ExecutionAcceptedEventSchema>;

export const ExecutionContentEventSchema = z.object({
  ...envelope,
  type: z.literal("content"),
  payload: ExecutionContentPayloadSchema,
});
export type ExecutionContentEvent = z.infer<typeof ExecutionContentEventSchema>;

export const ExecutionTerminalEventSchema = z.object({
  ...envelope,
  type: z.literal("terminal"),
  terminal: ExecutionTerminalSchema,
});
export type ExecutionTerminalEvent = z.infer<typeof ExecutionTerminalEventSchema>;

export const ExecutionEventV1Schema = z.discriminatedUnion("type", [
  ExecutionAcceptedEventSchema,
  ExecutionContentEventSchema,
  ExecutionTerminalEventSchema,
]);
export type ExecutionEventV1 = z.infer<typeof ExecutionEventV1Schema>;
