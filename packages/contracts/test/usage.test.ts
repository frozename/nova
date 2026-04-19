import { describe, expect, test } from 'bun:test';
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
