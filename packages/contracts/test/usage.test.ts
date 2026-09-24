import { describe, expect, test } from 'bun:test';
import * as nova from '../src/index.js';
import { UsageRecordSchema, type UsageRecord } from '../src/index.js';

describe('UsageRecordSchema', () => {
  test('parses a minimal valid record', () => {
    const record: UsageRecord = {
      ts: '2026-04-18T12:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4o-mini',
      kind: 'chat',
      prompt_tokens: 120,
      completion_tokens: 60,
      total_tokens: 180,
      latency_ms: 420,
    };
    expect(UsageRecordSchema.parse(record)).toEqual(record);
  });

  test('optional fields round-trip', () => {
    const record = UsageRecordSchema.parse({
      ts: '2026-04-18T12:00:00Z',
      provider: 'anthropic',
      model: 'claude-3-5',
      kind: 'chat',
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      latency_ms: 10,
      request_id: 'req_abc',
      estimated_cost_usd: 0.00042,
      user: 'alice',
      route: 'fusion-private-first',
    });
    expect(record.request_id).toBe('req_abc');
    expect(record.estimated_cost_usd).toBe(0.00042);
    expect(record.route).toBe('fusion-private-first');
  });

  test('rejects unknown kind', () => {
    expect(() =>
      UsageRecordSchema.parse({
        ts: 'x',
        provider: 'x',
        model: 'x',
        kind: 'magic',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      }),
    ).toThrow();
  });

  test('rejects negative token counts', () => {
    expect(() =>
      UsageRecordSchema.parse({
        ts: '2026-04-18T12:00:00Z',
        provider: 'x',
        model: 'x',
        kind: 'chat',
        prompt_tokens: -1,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      }),
    ).toThrow();
  });

  test('accepts zero-token records (adapters that return no usage)', () => {
    const parsed = UsageRecordSchema.parse({
      ts: '2026-04-18T12:00:00Z',
      provider: 'self-hosted',
      model: 'llama3',
      kind: 'chat',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      latency_ms: 0,
    });
    expect(parsed.total_tokens).toBe(0);
  });
});

// Accessed via the namespace so a missing export fails these tests on a
// real assertion (toBeDefined) rather than a module-load error.
const UsageObservationV1Schema = (nova as Record<string, unknown>)
  .UsageObservationV1Schema as
  | { parse(v: unknown): Record<string, unknown> }
  | undefined;
const UsageRecordV2Schema = (nova as Record<string, unknown>).UsageRecordV2Schema as
  | { parse(v: unknown): Record<string, unknown> }
  | undefined;
const projectUsageRecordV2ToV1 = (nova as Record<string, unknown>)
  .projectUsageRecordV2ToV1 as
  | ((v: unknown) => UsageRecord | null)
  | undefined;

describe('UsageObservationV1Schema', () => {
  test('is exported', () => {
    expect(UsageObservationV1Schema).toBeDefined();
  });

  test('observed round-trips with per-component counts', () => {
    const parsed = UsageObservationV1Schema?.parse({
      source: 'observed',
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
    });
    expect(parsed?.source).toBe('observed');
    expect(parsed?.input_tokens).toBe(10);
    expect(parsed?.output_tokens).toBe(4);
    expect(parsed?.total_tokens).toBe(14);
  });

  test('observed may carry only partial counts (no forced completeness)', () => {
    const parsed = UsageObservationV1Schema?.parse({
      source: 'observed',
      input_tokens: 7,
    });
    expect(parsed?.input_tokens).toBe(7);
    expect(parsed?.output_tokens).toBeUndefined();
    expect(parsed?.total_tokens).toBeUndefined();
  });

  test('optional attribution fields round-trip', () => {
    const parsed = UsageObservationV1Schema?.parse({
      source: 'estimated',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      cost: 0.0042,
      currency: 'USD',
      pricing_revision: '2026-09-01',
      upstream_request_id: 'chatcmpl-abc',
    });
    expect(parsed?.cache_read_tokens).toBe(3);
    expect(parsed?.cache_write_tokens).toBe(2);
    expect(parsed?.cost).toBe(0.0042);
    expect(parsed?.currency).toBe('USD');
    expect(parsed?.pricing_revision).toBe('2026-09-01');
    expect(parsed?.upstream_request_id).toBe('chatcmpl-abc');
  });

  test("'unknown' parses bare — no counts required", () => {
    const parsed = UsageObservationV1Schema?.parse({ source: 'unknown' });
    expect(parsed?.source).toBe('unknown');
  });

  test("'unknown' rejects invented counts (schema-enforced)", () => {
    for (const field of [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'cost',
    ]) {
      expect(() =>
        UsageObservationV1Schema?.parse({ source: 'unknown', [field]: 5 }),
      ).toThrow();
    }
  });

  test("'unknown' may still carry upstream_request_id (identity, not a count)", () => {
    const parsed = UsageObservationV1Schema?.parse({
      source: 'unknown',
      upstream_request_id: 'chatcmpl-xyz',
    });
    expect(parsed?.upstream_request_id).toBe('chatcmpl-xyz');
  });

  test('rejects a bad source', () => {
    expect(() =>
      UsageObservationV1Schema?.parse({ source: 'measured' }),
    ).toThrow();
  });

  test('rejects negative counts', () => {
    expect(() =>
      UsageObservationV1Schema?.parse({ source: 'observed', input_tokens: -1 }),
    ).toThrow();
  });
});

describe('UsageRecordV2Schema', () => {
  test('is exported', () => {
    expect(UsageRecordV2Schema).toBeDefined();
  });

  test('round-trips observation + request/attempt identity', () => {
    const record = {
      v: 2,
      ts: '2026-09-23T12:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4o-mini',
      kind: 'chat',
      latency_ms: 321,
      observation: {
        source: 'observed',
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      },
      request_id: 'req_1',
      attempt_id: 'attempt_2',
      route: 'private-first',
      user: 'alice',
    };
    const parsed = UsageRecordV2Schema?.parse(record) as
      | { observation?: { input_tokens?: number }; attempt_id?: string }
      | undefined;
    expect(parsed).toBeDefined();
    expect(parsed?.observation?.input_tokens).toBe(11);
    expect(parsed?.attempt_id).toBe('attempt_2');
  });

  test('carries an unknown-source observation with no counts', () => {
    const parsed = UsageRecordV2Schema?.parse({
      v: 2,
      ts: '2026-09-23T12:00:00.000Z',
      provider: 'self-hosted',
      model: 'llama3',
      kind: 'chat',
      latency_ms: 50,
      observation: { source: 'unknown' },
    });
    expect(parsed).toBeDefined();
  });
});

describe('projectUsageRecordV2ToV1', () => {
  const base = {
    v: 2,
    ts: '2026-09-23T12:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4o-mini',
    kind: 'chat',
    latency_ms: 321,
    request_id: 'req_1',
    route: 'r1',
  };

  test('is exported', () => {
    expect(projectUsageRecordV2ToV1).toBeDefined();
  });

  test('fully observed counts project to a V1 record', () => {
    const v1 = projectUsageRecordV2ToV1?.({
      ...base,
      observation: {
        source: 'observed',
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      },
    });
    expect(v1).not.toBeNull();
    expect(v1?.prompt_tokens).toBe(11);
    expect(v1?.completion_tokens).toBe(7);
    expect(v1?.total_tokens).toBe(18);
    expect(v1?.provider).toBe('openai');
    expect(v1?.latency_ms).toBe(321);
    expect(v1?.request_id).toBe('req_1');
    expect(v1?.route).toBe('r1');
    // Projected record must satisfy the untouched V1 schema.
    expect(() => UsageRecordSchema.parse(v1)).not.toThrow();
  });

  test('partial counts → null (never a zero-filled record)', () => {
    for (const observation of [
      { source: 'observed', input_tokens: 11, output_tokens: 7 },
      { source: 'observed', input_tokens: 11, total_tokens: 18 },
      { source: 'observed', output_tokens: 7, total_tokens: 18 },
      { source: 'observed' },
    ]) {
      expect(projectUsageRecordV2ToV1?.({ ...base, observation })).toBeNull();
    }
  });

  test("'unknown' source → null", () => {
    expect(
      projectUsageRecordV2ToV1?.({
        ...base,
        observation: { source: 'unknown' },
      }),
    ).toBeNull();
  });

  test("'estimated' source → null even when all counts present", () => {
    expect(
      projectUsageRecordV2ToV1?.({
        ...base,
        observation: {
          source: 'estimated',
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      }),
    ).toBeNull();
  });

  test('USD cost maps to estimated_cost_usd; other currencies do not', () => {
    const usd = projectUsageRecordV2ToV1?.({
      ...base,
      observation: {
        source: 'observed',
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost: 0.01,
        currency: 'USD',
      },
    });
    expect(usd?.estimated_cost_usd).toBe(0.01);
    const eur = projectUsageRecordV2ToV1?.({
      ...base,
      observation: {
        source: 'observed',
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost: 0.01,
        currency: 'EUR',
      },
    });
    expect(eur?.estimated_cost_usd).toBeUndefined();
  });
});
