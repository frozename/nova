import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, defaultAuditDir } from '../src/audit.js';
import { toTextContent } from '../src/content.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-mcp-audit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendAudit', () => {
  test('writes one JSONL record per call into <server>-<date>.jsonl', () => {
    const now = () => new Date('2026-04-18T12:00:00Z');
    appendAudit({ dir, server: 'llamactl', tool: 'foo', input: { a: 1 }, now });
    appendAudit({ dir, server: 'llamactl', tool: 'bar', input: { b: 2 }, dryRun: true, now });
    const files = readdirSync(dir);
    expect(files).toEqual(['llamactl-2026-04-18.jsonl']);
    const body = readFileSync(join(dir, files[0]!), 'utf8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs[0].tool).toBe('foo');
    expect(recs[0].dryRun).toBe(false);
    expect(recs[1].tool).toBe('bar');
    expect(recs[1].dryRun).toBe(true);
    expect(recs[1].input).toEqual({ b: 2 });
  });

  test('separates records by server slug', () => {
    const now = () => new Date('2026-04-18T12:00:00Z');
    appendAudit({ dir, server: 'llamactl', tool: 'a', input: {}, now });
    appendAudit({ dir, server: 'sirius', tool: 'b', input: {}, now });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['llamactl-2026-04-18.jsonl', 'sirius-2026-04-18.jsonl']);
  });

  test('defaultAuditDir honors LLAMACTL_MCP_AUDIT_DIR', () => {
    expect(defaultAuditDir({ LLAMACTL_MCP_AUDIT_DIR: '/custom' })).toBe('/custom');
    const withoutOverride = defaultAuditDir({ HOME: '/home/user' } as NodeJS.ProcessEnv);
    expect(withoutOverride).toContain('/.llamactl/mcp/audit');
  });
});

describe('toTextContent', () => {
  test('wraps JSON payload in MCP text envelope', () => {
    const env = toTextContent({ hello: 'world' });
    expect(env.content).toHaveLength(1);
    expect(env.content[0]!.type).toBe('text');
    expect(JSON.parse(env.content[0]!.text)).toEqual({ hello: 'world' });
  });
});
