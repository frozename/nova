import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendUsage,
  appendUsageBackground,
  defaultUsageDir,
} from '../src/usage.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendUsage', () => {
  test('writes one JSONL line per call, rotated by (provider, day)', () => {
    const now = () => new Date('2026-04-18T12:00:00Z');
    appendUsage({
      dir,
      now,
      record: {
        ts: '2026-04-18T12:00:00Z',
        provider: 'openai',
        model: 'gpt-4o-mini',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        latency_ms: 100,
      },
    });
    appendUsage({
      dir,
      now,
      record: {
        ts: '2026-04-18T12:05:00Z',
        provider: 'anthropic',
        model: 'claude',
        kind: 'chat',
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        latency_ms: 50,
      },
    });
    appendUsage({
      dir,
      now,
      record: {
        ts: '2026-04-18T12:10:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        latency_ms: 200,
      },
    });

    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'anthropic-2026-04-18.jsonl',
      'openai-2026-04-18.jsonl',
    ]);
    const openaiLines = readFileSync(join(dir, 'openai-2026-04-18.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(openaiLines).toHaveLength(2);
    const first = JSON.parse(openaiLines[0]!);
    expect(first.model).toBe('gpt-4o-mini');
    expect(first.total_tokens).toBe(15);
  });

  test('rotates files on UTC day boundary', () => {
    appendUsage({
      dir,
      now: () => new Date('2026-04-18T23:59:59Z'),
      record: {
        ts: 'x',
        provider: 'openai',
        model: 'm',
        kind: 'chat',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      },
    });
    appendUsage({
      dir,
      now: () => new Date('2026-04-19T00:00:01Z'),
      record: {
        ts: 'x',
        provider: 'openai',
        model: 'm',
        kind: 'chat',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      },
    });
    expect(readdirSync(dir).sort()).toEqual([
      'openai-2026-04-18.jsonl',
      'openai-2026-04-19.jsonl',
    ]);
  });

  test('stamps ts when missing', () => {
    const fixed = new Date('2026-04-18T12:00:00.000Z');
    const path = appendUsage({
      dir,
      now: () => fixed,
      record: {
        provider: 'openai',
        model: 'm',
        kind: 'chat',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      },
    });
    const line = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(line.ts).toBe('2026-04-18T12:00:00.000Z');
  });

  test('preserves pre-supplied ts', () => {
    const path = appendUsage({
      dir,
      record: {
        ts: '2020-01-01T00:00:00Z',
        provider: 'openai',
        model: 'm',
        kind: 'chat',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      },
    });
    const line = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(line.ts).toBe('2020-01-01T00:00:00Z');
  });

  test('rejects record without provider field', () => {
    expect(() =>
      appendUsage({
        dir,
        record: { model: 'm' },
      }),
    ).toThrow(/provider is required/);
  });

  test('sanitizes provider slug to prevent path-traversal via slashes', () => {
    appendUsage({
      dir,
      now: () => new Date('2026-04-18T00:00:00Z'),
      record: {
        provider: 'evil/../escape',
        model: 'm',
        kind: 'chat',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latency_ms: 0,
      },
    });
    const files = readdirSync(dir);
    // Slash got replaced with underscore; the file lives inside dir,
    // not two levels up.
    expect(files[0]).toBe('evil_.._escape-2026-04-18.jsonl');
  });
});

describe('appendUsageBackground', () => {
  test('swallows writer errors silently — never throws in the hot path', () => {
    // Point at a nonexistent, unwritable parent; usage.ts does
    // mkdirSync recursive which should succeed on tmpdir. Simulate
    // failure by passing a bogus record with no provider.
    expect(() =>
      appendUsageBackground({
        dir,
        record: { model: 'no-provider' },
      }),
    ).not.toThrow();
  });
});

describe('defaultUsageDir', () => {
  test('honors LLAMACTL_USAGE_DIR', () => {
    expect(defaultUsageDir({ LLAMACTL_USAGE_DIR: '/explicit' })).toBe('/explicit');
  });
  test('falls back to DEV_STORAGE/usage', () => {
    expect(defaultUsageDir({ DEV_STORAGE: '/tmp/dev' })).toBe('/tmp/dev/usage');
  });
});
