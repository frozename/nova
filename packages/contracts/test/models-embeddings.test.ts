import { describe, expect, test } from "bun:test";

import {
  ModelInfoSchema,
  ModelListResponseSchema,
  UnifiedEmbeddingRequestSchema,
  UnifiedEmbeddingResponseSchema,
} from "../src/index.js";

/**
 * Pins the model catalog and embedding wire schemas in `src/schemas/models.ts`
 * and `src/schemas/embeddings.ts`. llamactl, embersynth and sirius-gateway
 * validate `/v1/models` and `/v1/embeddings` payloads against these, so the
 * bounds below are part of the public contract:
 *  - a model list is `object: "list"`, may be empty, and each entry is
 *    `object: "model"` with an integer `created`
 *  - contextLength and maxOutputTokens are positive integers, null or absent
 *  - cost rates are non-negative numbers, null or absent
 *  - an embedding response has at least one row; each row is
 *    `object: "embedding"` with a non-negative integer index and a float
 *    array or base64 string embedding
 *  - usage counts and latencyMs are non-negative, and usage is optional
 *  - an embedding request accepts token arrays, only the float and base64
 *    encoding formats, and positive integer dimensions
 * Assertions use safeParse(...).success and parsed values only.
 */

const MODEL = { created: 1_700_000_000, id: "m-1", object: "model", owned_by: "local" };

const ROW = { embedding: [0.1, 0.2], index: 0, object: "embedding" as const };

const EMBED_RES = { data: [ROW], model: "e-1", object: "list" as const };

describe("models ModelListResponseSchema", () => {
  test("accepts a list with one minimal model", () => {
    expect(ModelListResponseSchema.safeParse({ data: [MODEL], object: "list" }).success).toBe(true);
  });

  test("accepts an empty model list", () => {
    expect(ModelListResponseSchema.safeParse({ data: [], object: "list" }).success).toBe(true);
  });

  test("rejects object 'model' at the list level", () => {
    expect(ModelListResponseSchema.safeParse({ data: [MODEL], object: "model" }).success).toBe(
      false,
    );
  });
});

describe("models ModelInfoSchema", () => {
  test("rejects object 'list' and a fractional created", () => {
    expect(ModelInfoSchema.safeParse({ ...MODEL, object: "list" }).success).toBe(false);
    expect(ModelInfoSchema.safeParse({ ...MODEL, created: 1.5 }).success).toBe(false);
  });

  test("rejects contextLength 0 and maxOutputTokens 0", () => {
    expect(ModelInfoSchema.safeParse({ ...MODEL, contextLength: 0 }).success).toBe(false);
    expect(ModelInfoSchema.safeParse({ ...MODEL, maxOutputTokens: 0 }).success).toBe(false);
  });

  test("rejects a fractional contextLength", () => {
    expect(ModelInfoSchema.safeParse({ ...MODEL, contextLength: 1.5 }).success).toBe(false);
  });

  test("keeps positive contextLength and maxOutputTokens", () => {
    const parsed = ModelInfoSchema.parse({
      ...MODEL,
      contextLength: 128_000,
      maxOutputTokens: 4096,
    });
    expect(parsed.contextLength).toBe(128_000);
    expect(parsed.maxOutputTokens).toBe(4096);
  });

  test("accepts null contextLength and maxOutputTokens", () => {
    const parsed = ModelInfoSchema.parse({ ...MODEL, contextLength: null, maxOutputTokens: null });
    expect(parsed.contextLength).toBeNull();
    expect(parsed.maxOutputTokens).toBeNull();
  });

  test("accepts absent contextLength, maxOutputTokens and cost", () => {
    const parsed = ModelInfoSchema.parse(MODEL);
    expect("contextLength" in parsed).toBe(false);
    expect("maxOutputTokens" in parsed).toBe(false);
    expect("cost" in parsed).toBe(false);
  });
});

describe("models cost through ModelInfoSchema", () => {
  test("accepts 0 and null rates", () => {
    const cost = { inputPerMTokUsd: 0, outputPerMTokUsd: null };
    expect(ModelInfoSchema.parse({ ...MODEL, cost }).cost).toEqual(cost);
    const swapped = { inputPerMTokUsd: null, outputPerMTokUsd: 0 };
    expect(ModelInfoSchema.parse({ ...MODEL, cost: swapped }).cost).toEqual(swapped);
  });

  test("accepts an empty cost object", () => {
    expect(ModelInfoSchema.parse({ ...MODEL, cost: {} }).cost).toEqual({});
  });

  test("rejects a negative input or output rate", () => {
    expect(ModelInfoSchema.safeParse({ ...MODEL, cost: { inputPerMTokUsd: -0.01 } }).success).toBe(
      false,
    );
    expect(ModelInfoSchema.safeParse({ ...MODEL, cost: { outputPerMTokUsd: -0.01 } }).success).toBe(
      false,
    );
  });
});

describe("embeddings UnifiedEmbeddingResponseSchema", () => {
  test("round-trips a minimal float-vector response without usage", () => {
    const parsed = UnifiedEmbeddingResponseSchema.parse(EMBED_RES);
    expect(parsed).toEqual(EMBED_RES);
    expect("usage" in parsed).toBe(false);
  });

  test("accepts a base64 string embedding", () => {
    const res = { ...EMBED_RES, data: [{ ...ROW, embedding: "AAAAAA==" }] };
    expect(UnifiedEmbeddingResponseSchema.parse(res)).toEqual(res);
  });

  test("rejects an empty data array", () => {
    expect(UnifiedEmbeddingResponseSchema.safeParse({ ...EMBED_RES, data: [] }).success).toBe(
      false,
    );
  });

  test("rejects a row index of -1 or 1.5", () => {
    const negative = { ...EMBED_RES, data: [{ ...ROW, index: -1 }] };
    expect(UnifiedEmbeddingResponseSchema.safeParse(negative).success).toBe(false);
    const fractional = { ...EMBED_RES, data: [{ ...ROW, index: 1.5 }] };
    expect(UnifiedEmbeddingResponseSchema.safeParse(fractional).success).toBe(false);
  });

  test("rejects a row whose object is not 'embedding'", () => {
    const res = { ...EMBED_RES, data: [{ ...ROW, object: "list" }] };
    expect(UnifiedEmbeddingResponseSchema.safeParse(res).success).toBe(false);
  });

  test("accepts zero usage counts and rejects negative ones", () => {
    const zero = { ...EMBED_RES, usage: { prompt_tokens: 0, total_tokens: 0 } };
    expect(UnifiedEmbeddingResponseSchema.parse(zero)).toEqual(zero);
    const badPrompt = { ...EMBED_RES, usage: { prompt_tokens: -1, total_tokens: 2 } };
    expect(UnifiedEmbeddingResponseSchema.safeParse(badPrompt).success).toBe(false);
    const badTotal = { ...EMBED_RES, usage: { prompt_tokens: 2, total_tokens: -1 } };
    expect(UnifiedEmbeddingResponseSchema.safeParse(badTotal).success).toBe(false);
  });

  test("accepts a fractional latencyMs and rejects a negative one", () => {
    expect(UnifiedEmbeddingResponseSchema.parse({ ...EMBED_RES, latencyMs: 12.5 }).latencyMs).toBe(
      12.5,
    );
    expect(UnifiedEmbeddingResponseSchema.safeParse({ ...EMBED_RES, latencyMs: -1 }).success).toBe(
      false,
    );
  });
});

describe("embeddings UnifiedEmbeddingRequestSchema", () => {
  test("accepts token arrays as input", () => {
    const single = { input: [1, 2, 3], model: "e-1" };
    expect(UnifiedEmbeddingRequestSchema.parse(single)).toEqual(single);
    const batch = { input: [[1, 2], [3]], model: "e-1" };
    expect(UnifiedEmbeddingRequestSchema.parse(batch)).toEqual(batch);
  });

  test("accepts encoding_format base64 and rejects int8", () => {
    const req = { encoding_format: "base64", input: "hi", model: "e-1" };
    expect(UnifiedEmbeddingRequestSchema.safeParse(req).success).toBe(true);
    expect(
      UnifiedEmbeddingRequestSchema.safeParse({ ...req, encoding_format: "int8" }).success,
    ).toBe(false);
  });

  test("accepts dimensions 256 and rejects 0 and 1.5", () => {
    const req = { dimensions: 256, input: "hi", model: "e-1" };
    expect(UnifiedEmbeddingRequestSchema.parse(req).dimensions).toBe(256);
    expect(UnifiedEmbeddingRequestSchema.safeParse({ ...req, dimensions: 0 }).success).toBe(false);
    expect(UnifiedEmbeddingRequestSchema.safeParse({ ...req, dimensions: 1.5 }).success).toBe(
      false,
    );
  });
});
