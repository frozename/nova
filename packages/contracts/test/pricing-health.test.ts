import { describe, expect, test } from "bun:test";

import {
  ModelPricingSchema,
  ProviderHealthSchema,
  ProviderHealthStateSchema,
  ProviderPricingSchema,
} from "../src/index.js";

/**
 * Pins the pricing catalog and provider health wire schemas in
 * `src/schemas/pricing.ts` and `src/schemas/health.ts`. `loadPricing()` in
 * `@novaproto/mcp-shared` validates every pricing YAML file against
 * ProviderPricingSchema, and adapters report ProviderHealth, so the bounds
 * below are part of the public contract:
 *  - a model's prompt and completion per-1k rates are required non-negative
 *    numbers, and 0 is valid
 *  - meta is optional and keeps arbitrary keys
 *  - a provider catalog has a non-empty provider name and a models record,
 *    which may be empty, and every entry in it is validated
 *  - the health state is one of healthy, degraded, unhealthy or unknown
 *  - lastChecked is required; latencyMs is non-negative, null or absent;
 *    error is a string, null or absent
 * Assertions use safeParse(...).success and parsed values only.
 */

const RATES = { completion_per_1k_tokens_usd: 0.0006, prompt_per_1k_tokens_usd: 0.00015 };

const CHECKED_AT = "2026-10-25T12:00:00.000Z";

const HEALTH = { lastChecked: CHECKED_AT, state: "healthy" as const };

describe("pricing ModelPricingSchema", () => {
  test("accepts zero prompt and completion rates", () => {
    const zero = { completion_per_1k_tokens_usd: 0, prompt_per_1k_tokens_usd: 0 };
    expect(ModelPricingSchema.parse(zero)).toEqual(zero);
  });

  test("rejects a negative prompt or completion rate", () => {
    const badPrompt = { ...RATES, prompt_per_1k_tokens_usd: -0.001 };
    expect(ModelPricingSchema.safeParse(badPrompt).success).toBe(false);
    const badCompletion = { ...RATES, completion_per_1k_tokens_usd: -0.001 };
    expect(ModelPricingSchema.safeParse(badCompletion).success).toBe(false);
  });

  test("rejects a missing prompt or completion rate", () => {
    expect(ModelPricingSchema.safeParse({ completion_per_1k_tokens_usd: 0.0006 }).success).toBe(
      false,
    );
    expect(ModelPricingSchema.safeParse({ prompt_per_1k_tokens_usd: 0.00015 }).success).toBe(false);
  });

  test("rejects a rate given as a string", () => {
    const stringPrompt = { ...RATES, prompt_per_1k_tokens_usd: "0.00015" };
    expect(ModelPricingSchema.safeParse(stringPrompt).success).toBe(false);
    const stringCompletion = { ...RATES, completion_per_1k_tokens_usd: "0.0006" };
    expect(ModelPricingSchema.safeParse(stringCompletion).success).toBe(false);
  });

  test("keeps arbitrary meta keys", () => {
    const meta = { billing: "per-second", nested: { tier: 2 }, per_second_usd: 0.01 };
    expect(ModelPricingSchema.parse({ ...RATES, meta }).meta).toEqual(meta);
  });

  test("accepts an entry without meta", () => {
    const parsed = ModelPricingSchema.parse(RATES);
    expect(parsed).toEqual(RATES);
    expect("meta" in parsed).toBe(false);
  });
});

describe("pricing ProviderPricingSchema", () => {
  test("accepts a two-model catalog", () => {
    const catalog = {
      models: {
        "gpt-4o-mini": RATES,
        "text-embedding-3-small": {
          completion_per_1k_tokens_usd: 0,
          prompt_per_1k_tokens_usd: 0.00002,
        },
      },
      provider: "openai",
    };
    expect(ProviderPricingSchema.parse(catalog)).toEqual(catalog);
  });

  test("rejects an empty provider and accepts a one-character one", () => {
    expect(ProviderPricingSchema.safeParse({ models: {}, provider: "" }).success).toBe(false);
    expect(ProviderPricingSchema.safeParse({ models: {}, provider: "x" }).success).toBe(true);
  });

  test("rejects a catalog with one model entry carrying a negative rate", () => {
    const models = {
      "bad-model": { ...RATES, completion_per_1k_tokens_usd: -1 },
      "gpt-4o-mini": RATES,
    };
    expect(ProviderPricingSchema.safeParse({ models, provider: "openai" }).success).toBe(false);
  });

  test("accepts an empty models record", () => {
    expect(ProviderPricingSchema.parse({ models: {}, provider: "together" }).models).toEqual({});
  });
});

describe("health ProviderHealthStateSchema", () => {
  test("accepts exactly healthy, degraded, unhealthy and unknown", () => {
    expect(ProviderHealthStateSchema.options).toHaveLength(4);
    for (const state of ["healthy", "degraded", "unhealthy", "unknown"]) {
      expect(ProviderHealthStateSchema.safeParse(state).success).toBe(true);
    }
  });

  test("rejects 'down' and 'HEALTHY'", () => {
    expect(ProviderHealthStateSchema.safeParse("down").success).toBe(false);
    expect(ProviderHealthStateSchema.safeParse("HEALTHY").success).toBe(false);
  });
});

describe("health ProviderHealthSchema", () => {
  test("accepts latencyMs null, absent or 0", () => {
    expect(ProviderHealthSchema.parse({ ...HEALTH, latencyMs: null }).latencyMs).toBeNull();
    expect("latencyMs" in ProviderHealthSchema.parse(HEALTH)).toBe(false);
    expect(ProviderHealthSchema.parse({ ...HEALTH, latencyMs: 0 }).latencyMs).toBe(0);
  });

  test("rejects a negative latencyMs", () => {
    expect(ProviderHealthSchema.safeParse({ ...HEALTH, latencyMs: -1 }).success).toBe(false);
  });

  test("accepts error null or absent", () => {
    expect(ProviderHealthSchema.parse({ ...HEALTH, error: null }).error).toBeNull();
    expect("error" in ProviderHealthSchema.parse(HEALTH)).toBe(false);
  });

  test("round-trips a degraded report with an error reason", () => {
    const report = {
      ...HEALTH,
      error: "slow upstream",
      latencyMs: 950,
      state: "degraded" as const,
    };
    expect(ProviderHealthSchema.parse(report)).toEqual(report);
  });

  test("rejects a payload without lastChecked", () => {
    expect(ProviderHealthSchema.safeParse({ state: "healthy" }).success).toBe(false);
  });
});
