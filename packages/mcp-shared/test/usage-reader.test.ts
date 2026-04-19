import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsage } from '../src/usage-reader.js';

let dir = '';

function write(name: string, lines: Array<Record<string, unknown> | string>): void {
  writeFileSync(
    join(dir, name),
    lines
      .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n',
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-usage-read-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readUsage', () => {
  test('returns empty result when the dir does not exist', () => {
    const res = readUsage({ dir: join(dir, 'does-not-exist') });
    expect(res.records).toEqual([]);
    expect(res.filesScanned).toEqual([]);
    expect(res.malformedLines).toBe(0);
  });

  test('aggregates records across multiple files sorted by filename', () => {
    write('openai-2026-04-17.jsonl', [
      { ts: '2026-04-17T10:00:00Z', provider: 'openai', model: 'gpt-4o-mini', total_tokens: 10 },
      { ts: '2026-04-17T11:00:00Z', provider: 'openai', model: 'gpt-4o', total_tokens: 20 },
    ]);
    write('anthropic-2026-04-17.jsonl', [
      { ts: '2026-04-17T12:00:00Z', provider: 'anthropic', model: 'claude-opus', total_tokens: 30 },
    ]);
    const res = readUsage({ dir });
    expect(res.records).toHaveLength(3);
    expect(res.filesScanned).toHaveLength(2);
    // Alphabetical file order: anthropic before openai.
    expect(res.filesScanned[0]).toContain('anthropic-');
  });

  test('time window excludes records outside [since, until)', () => {
    write('openai-2026-04-17.jsonl', [
      { ts: '2026-04-17T08:00:00Z', provider: 'openai', model: 'm', total_tokens: 1 },
      { ts: '2026-04-17T12:00:00Z', provider: 'openai', model: 'm', total_tokens: 2 },
      { ts: '2026-04-17T16:00:00Z', provider: 'openai', model: 'm', total_tokens: 3 },
    ]);
    const res = readUsage({
      dir,
      since: '2026-04-17T10:00:00Z',
      until: '2026-04-17T14:00:00Z',
    });
    expect(res.records.map((r) => r.total_tokens)).toEqual([2]);
  });

  test('provider filter skips files with non-matching prefix', () => {
    write('openai-2026-04-17.jsonl', [{ provider: 'openai', model: 'm', total_tokens: 1 }]);
    write('anthropic-2026-04-17.jsonl', [{ provider: 'anthropic', model: 'm', total_tokens: 2 }]);
    const res = readUsage({ dir, provider: 'openai' });
    expect(res.filesScanned).toHaveLength(1);
    expect(res.filesScanned[0]).toContain('openai-');
    expect(res.records).toHaveLength(1);
  });

  test('day-boundary pre-filter skips files entirely outside the window', () => {
    write('openai-2026-04-15.jsonl', [{ ts: '2026-04-15T10:00:00Z', provider: 'openai', model: 'm' }]);
    write('openai-2026-04-17.jsonl', [{ ts: '2026-04-17T10:00:00Z', provider: 'openai', model: 'm' }]);
    const res = readUsage({
      dir,
      since: '2026-04-17T00:00:00Z',
      until: '2026-04-18T00:00:00Z',
    });
    expect(res.filesScanned).toHaveLength(1);
    expect(res.records).toHaveLength(1);
  });

  test('malformed JSON lines are dropped silently + counted', () => {
    write('openai-2026-04-17.jsonl', [
      { provider: 'openai', model: 'm', total_tokens: 1 },
      '{not json',
      { provider: 'openai', model: 'm', total_tokens: 2 },
      '',
      'broken }',
    ]);
    const res = readUsage({ dir });
    expect(res.records).toHaveLength(2);
    expect(res.malformedLines).toBe(2);
  });

  test('non-.jsonl files and non-conforming filenames are skipped', () => {
    writeFileSync(join(dir, 'README.md'), 'hello');
    writeFileSync(join(dir, 'openai.jsonl'), '{}');  // no date suffix
    write('openai-2026-04-17.jsonl', [{ provider: 'openai', model: 'm' }]);
    const res = readUsage({ dir });
    expect(res.filesScanned).toHaveLength(1);
  });
});
