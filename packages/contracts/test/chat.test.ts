import { describe, expect, test } from "bun:test";

import {
  ChatMessageSchema,
  ContentBlockSchema,
  FinishReasonSchema,
  ResponseFormatSchema,
  RoleSchema,
  ToolChoiceSchema,
  UnifiedAiRequestSchema,
  UnifiedAiResponseSchema,
  UsageSchema,
} from "../src/index.js";

/**
 * Pins the value-level rules of the chat wire schemas in
 * `src/schemas/chat.ts` that the round-trip cases in schemas.test.ts
 * leave unchecked:
 *  - request sampler bounds: temperature 0..2, top_p 0..1, max_tokens a
 *    positive integer, frequency_penalty and presence_penalty -2..2
 *  - stop is a string or a string array
 *  - the role, finish-reason, image detail and audio format enums
 *  - content may be null; an unknown content block type is rejected
 *  - tool_choice and response_format accept only their listed shapes
 *  - a response has at least one choice, object "chat.completion", and
 *    non-negative integer usage counts
 * Assertions use safeParse(...).success and parsed values only.
 */

const BASE_REQUEST = { messages: [{ content: "hi", role: "user" }], model: "gpt-4o-mini" };

const BASE_CHOICE = {
  finish_reason: "stop",
  index: 0,
  message: { content: "hello", role: "assistant" },
};

const BASE_RESPONSE = {
  choices: [BASE_CHOICE],
  created: 1_700_000_000,
  id: "chatcmpl-1",
  model: "gpt-4o-mini",
  object: "chat.completion",
};

function requestAccepts(extra: Record<string, unknown>): boolean {
  return UnifiedAiRequestSchema.safeParse({ ...BASE_REQUEST, ...extra }).success;
}

function responseAccepts(extra: Record<string, unknown>): boolean {
  return UnifiedAiResponseSchema.safeParse({ ...BASE_RESPONSE, ...extra }).success;
}

describe("chat UnifiedAiRequestSchema", () => {
  test("accepts the base request", () => {
    expect(requestAccepts({})).toBe(true);
  });

  test("temperature accepts 0 and 2 and rejects -0.01 and 2.01", () => {
    expect(requestAccepts({ temperature: 0 })).toBe(true);
    expect(requestAccepts({ temperature: 2 })).toBe(true);
    expect(requestAccepts({ temperature: -0.01 })).toBe(false);
    expect(requestAccepts({ temperature: 2.01 })).toBe(false);
  });

  test("top_p accepts 0 and 1 and rejects -0.01 and 1.01", () => {
    expect(requestAccepts({ top_p: 0 })).toBe(true);
    expect(requestAccepts({ top_p: 1 })).toBe(true);
    expect(requestAccepts({ top_p: -0.01 })).toBe(false);
    expect(requestAccepts({ top_p: 1.01 })).toBe(false);
  });

  test("max_tokens accepts 1 and rejects 0, -1 and 1.5", () => {
    expect(requestAccepts({ max_tokens: 1 })).toBe(true);
    expect(requestAccepts({ max_tokens: 0 })).toBe(false);
    expect(requestAccepts({ max_tokens: -1 })).toBe(false);
    expect(requestAccepts({ max_tokens: 1.5 })).toBe(false);
  });

  test("frequency_penalty accepts -2 and 2 and rejects -2.01 and 2.01", () => {
    expect(requestAccepts({ frequency_penalty: -2 })).toBe(true);
    expect(requestAccepts({ frequency_penalty: 2 })).toBe(true);
    expect(requestAccepts({ frequency_penalty: -2.01 })).toBe(false);
    expect(requestAccepts({ frequency_penalty: 2.01 })).toBe(false);
  });

  test("presence_penalty accepts -2 and 2 and rejects -2.01 and 2.01", () => {
    expect(requestAccepts({ presence_penalty: -2 })).toBe(true);
    expect(requestAccepts({ presence_penalty: 2 })).toBe(true);
    expect(requestAccepts({ presence_penalty: -2.01 })).toBe(false);
    expect(requestAccepts({ presence_penalty: 2.01 })).toBe(false);
  });

  test("stop accepts a string and a string array and rejects a number", () => {
    expect(requestAccepts({ stop: "END" })).toBe(true);
    expect(requestAccepts({ stop: ["END", "STOP"] })).toBe(true);
    expect(requestAccepts({ stop: 1 })).toBe(false);
  });
});

describe("chat roles and messages", () => {
  test("RoleSchema accepts developer and tool and rejects bot", () => {
    expect(RoleSchema.safeParse("developer").success).toBe(true);
    expect(RoleSchema.safeParse("tool").success).toBe(true);
    expect(RoleSchema.safeParse("bot").success).toBe(false);
  });

  test("ChatMessageSchema accepts content null", () => {
    expect(ChatMessageSchema.parse({ content: null, role: "assistant" }).content).toBeNull();
  });
});

describe("chat ContentBlockSchema", () => {
  test("input_audio accepts wav and mp3 and rejects ogg", () => {
    const wav = { input_audio: { data: "AAAA", format: "wav" }, type: "input_audio" };
    expect(ContentBlockSchema.safeParse(wav).success).toBe(true);
    const mp3 = { input_audio: { data: "AAAA", format: "mp3" }, type: "input_audio" };
    expect(ContentBlockSchema.safeParse(mp3).success).toBe(true);
    const ogg = { input_audio: { data: "AAAA", format: "ogg" }, type: "input_audio" };
    expect(ContentBlockSchema.safeParse(ogg).success).toBe(false);
  });

  test("image_url rejects detail ultra", () => {
    const ultra = {
      image_url: { detail: "ultra", url: "https://example.com/cat.png" },
      type: "image_url",
    };
    expect(ContentBlockSchema.safeParse(ultra).success).toBe(false);
  });

  test("rejects an unknown block type", () => {
    const video = { type: "video", video: { url: "https://example.com/cat.mp4" } };
    expect(ContentBlockSchema.safeParse(video).success).toBe(false);
  });
});

describe("chat ToolChoiceSchema and ResponseFormatSchema", () => {
  test("ToolChoiceSchema accepts none, required and a named function and rejects any", () => {
    expect(ToolChoiceSchema.safeParse("none").success).toBe(true);
    expect(ToolChoiceSchema.safeParse("required").success).toBe(true);
    const named = { function: { name: "lookup" }, type: "function" };
    expect(ToolChoiceSchema.safeParse(named).success).toBe(true);
    expect(ToolChoiceSchema.safeParse("any").success).toBe(false);
  });

  test("ResponseFormatSchema accepts text and json_object", () => {
    expect(ResponseFormatSchema.safeParse({ type: "text" }).success).toBe(true);
    expect(ResponseFormatSchema.safeParse({ type: "json_object" }).success).toBe(true);
  });

  test("ResponseFormatSchema rejects json_schema without its json_schema object", () => {
    expect(ResponseFormatSchema.safeParse({ type: "json_schema" }).success).toBe(false);
  });
});

describe("chat UnifiedAiResponseSchema", () => {
  test("accepts the base response", () => {
    expect(responseAccepts({})).toBe(true);
  });

  test("rejects an empty choices array", () => {
    expect(responseAccepts({ choices: [] })).toBe(false);
  });

  test("rejects object chat.completion.chunk", () => {
    expect(responseAccepts({ object: "chat.completion.chunk" })).toBe(false);
  });

  test("accepts finish_reason null", () => {
    expect(responseAccepts({ choices: [{ ...BASE_CHOICE, finish_reason: null }] })).toBe(true);
  });

  test("FinishReasonSchema rejects max_tokens", () => {
    expect(FinishReasonSchema.safeParse("max_tokens").success).toBe(false);
  });

  test("UsageSchema rejects a negative prompt_tokens and a non-integer total_tokens", () => {
    const usage = { completion_tokens: 1, prompt_tokens: 3, total_tokens: 4 };
    expect(UsageSchema.safeParse(usage).success).toBe(true);
    expect(UsageSchema.safeParse({ ...usage, prompt_tokens: -1 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, total_tokens: 4.5 }).success).toBe(false);
  });
});
