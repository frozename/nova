import { describe, expect, test } from "bun:test";

import {
  StreamChoiceSchema,
  StreamCompletionSchema,
  StreamDeltaSchema,
  UnifiedStreamChunkSchema,
  UnifiedStreamEventSchema,
  UnifiedStreamToolCallEventSchema,
} from "../src/index.js";

/**
 * Pins the envelope rules of the streaming wire schemas in
 * `src/schemas/stream.ts` that the "nova stream schema" cases in
 * schemas.test.ts leave unchecked:
 *  - a chunk has at least one choice, object "chat.completion.chunk" and
 *    an integer created
 *  - a choice index is a non-negative integer; finish_reason may be null,
 *    absent or one of the finish reasons
 *  - a delta role is assistant or tool; content may be null; tool_calls
 *    takes partial deltas and full tool calls in one array
 *  - a tool_call event defaults choiceIndex to 0 and rejects a negative one
 *  - an error event needs error.message; an unknown event type is rejected
 *  - the done completion marker is upstream, eof or error
 * Assertions use safeParse(...).success and parsed values only.
 */

const BASE_CHOICE = { delta: { content: "hi" }, index: 0 };

const BASE_CHUNK = {
  choices: [BASE_CHOICE],
  created: 1_700_000_000,
  id: "chunk-1",
  model: "gpt-4o-mini",
  object: "chat.completion.chunk",
};

const TOOL_CALL = {
  function: { arguments: "{}", name: "lookup" },
  id: "call-1",
  type: "function" as const,
};

function chunkAccepts(extra: Record<string, unknown>): boolean {
  return UnifiedStreamChunkSchema.safeParse({ ...BASE_CHUNK, ...extra }).success;
}

function choiceAccepts(extra: Record<string, unknown>): boolean {
  return StreamChoiceSchema.safeParse({ ...BASE_CHOICE, ...extra }).success;
}

describe("stream UnifiedStreamChunkSchema", () => {
  test("accepts the base chunk with one choice", () => {
    expect(chunkAccepts({})).toBe(true);
  });

  test("rejects an empty choices array", () => {
    expect(chunkAccepts({ choices: [] })).toBe(false);
  });

  test("rejects object chat.completion", () => {
    expect(chunkAccepts({ object: "chat.completion" })).toBe(false);
  });

  test("rejects a non-integer created", () => {
    expect(chunkAccepts({ created: 1.5 })).toBe(false);
  });
});

describe("stream StreamChoiceSchema", () => {
  test("rejects a negative index", () => {
    expect(choiceAccepts({ index: -1 })).toBe(false);
  });

  test("accepts finish_reason null, absent and every finish reason", () => {
    expect(choiceAccepts({ finish_reason: null })).toBe(true);
    expect(choiceAccepts({})).toBe(true);
    const reasons = ["stop", "length", "tool_calls", "content_filter", "error"];
    const rejected = reasons.filter((reason) => !choiceAccepts({ finish_reason: reason }));
    expect(rejected).toEqual([]);
  });

  test("rejects an unknown finish_reason", () => {
    expect(choiceAccepts({ finish_reason: "timeout" })).toBe(false);
  });
});

describe("stream StreamDeltaSchema", () => {
  test("role accepts assistant and tool and rejects user and system", () => {
    expect(StreamDeltaSchema.safeParse({ role: "assistant" }).success).toBe(true);
    expect(StreamDeltaSchema.safeParse({ role: "tool" }).success).toBe(true);
    expect(StreamDeltaSchema.safeParse({ role: "user" }).success).toBe(false);
    expect(StreamDeltaSchema.safeParse({ role: "system" }).success).toBe(false);
  });

  test("content accepts null", () => {
    expect(StreamDeltaSchema.parse({ content: null }).content).toBeNull();
  });

  test("tool_calls accepts a partial delta and a full tool call in one array", () => {
    const partial = { function: { arguments: '{"a' }, index: 0 };
    const parsed = StreamDeltaSchema.parse({ tool_calls: [partial, TOOL_CALL] });
    expect(parsed.tool_calls).toEqual([partial, TOOL_CALL]);
  });

  test("tool_calls rejects an entry that is neither a delta nor a tool call", () => {
    expect(StreamDeltaSchema.safeParse({ tool_calls: [{ id: "call-1" }] }).success).toBe(false);
  });
});

describe("stream UnifiedStreamToolCallEventSchema", () => {
  test("fills choiceIndex 0 when it is omitted", () => {
    const parsed = UnifiedStreamToolCallEventSchema.parse({
      toolCall: TOOL_CALL,
      type: "tool_call",
    });
    expect(parsed).toEqual({ choiceIndex: 0, toolCall: TOOL_CALL, type: "tool_call" });
  });

  test("keeps an explicit choiceIndex 2", () => {
    const event = { choiceIndex: 2, toolCall: TOOL_CALL, type: "tool_call" };
    expect(UnifiedStreamToolCallEventSchema.parse(event).choiceIndex).toBe(2);
  });

  test("rejects a negative choiceIndex", () => {
    const event = { choiceIndex: -1, toolCall: TOOL_CALL, type: "tool_call" };
    expect(UnifiedStreamToolCallEventSchema.safeParse(event).success).toBe(false);
  });
});

describe("stream UnifiedStreamEventSchema", () => {
  test("error event rejects a missing message and accepts message with only code", () => {
    const noMessage = { error: { code: "rate_limited" }, type: "error" };
    expect(UnifiedStreamEventSchema.safeParse(noMessage).success).toBe(false);
    const withCode = { error: { code: "rate_limited", message: "slow down" }, type: "error" };
    expect(UnifiedStreamEventSchema.safeParse(withCode).success).toBe(true);
  });

  test("rejects an unknown event type", () => {
    const usage = { type: "usage", usage: { prompt_tokens: 1 } };
    expect(UnifiedStreamEventSchema.safeParse(usage).success).toBe(false);
  });

  test("StreamCompletionSchema options are upstream, eof and error", () => {
    expect(StreamCompletionSchema.options).toEqual(["upstream", "eof", "error"]);
  });
});
