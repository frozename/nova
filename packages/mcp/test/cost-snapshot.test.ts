import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCostSnapshot } from '../src/cost/snapshot.js';
import { buildNovaMcpServer } from '../src/server.js';

let dir = '';
let auditDir = '';
const originalEnv = { ...process.env };

function writeFile(name: string, records: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(dir, name),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-cost-'));
  auditDir = mkdtempSync(join(tmpdir(), 'nova-cost-audit-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, { LLAMACTL_MCP_AUDIT_DIR: auditDir });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(dir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

describe('computeCostSnapshot', () => {
  test('returns zeroed totals when the dir is empty', () => {
    const snap = computeCostSnapshot({
      dir,
      days: 7,
      now: () => new Date('2026-04-18T12:00:00Z'),
    });
    expect(snap.totalRequests).toBe(0);
    expect(snap.totalTokens).toBe(0);
    expect(snap.byProvider).toEqual([]);
    expect(snap.byModel).toEqual([]);
  });

  test('rolls up by provider + by (provider, model) with correct sums', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o-mini',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        latency_ms: 100,
      },
      {
        ts: '2026-04-17T11:00:00Z',
        provider: 'openai',
        model: 'gpt-4o-mini',
        kind: 'chat',
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
        latency_ms: 200,
      },
      {
        ts: '2026-04-17T12:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        latency_ms: 500,
      },
    ]);
    writeFile('anthropic-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T13:00:00Z',
        provider: 'anthropic',
        model: 'claude-opus',
        kind: 'chat',
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        latency_ms: 1000,
      },
    ]);
    const snap = computeCostSnapshot({
      dir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(snap.totalRequests).toBe(4);
    expect(snap.totalTokens).toBe(15 + 30 + 150 + 300);
    // Sort order: by totalTokens descending.
    expect(snap.byProvider.map((g) => g.key)).toEqual(['anthropic', 'openai']);
    const openai = snap.byProvider.find((g) => g.key === 'openai')!;
    expect(openai.requestCount).toBe(3);
    expect(openai.totalTokens).toBe(195);
    expect(openai.avgLatencyMs).toBe((100 + 200 + 500) / 3);
    expect(snap.byModel.map((g) => g.key)).toEqual([
      'anthropic/claude-opus',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ]);
    const mini = snap.byModel.find((g) => g.key === 'openai/gpt-4o-mini')!;
    expect(mini.requestCount).toBe(2);
    expect(mini.promptTokens).toBe(30);
    expect(mini.completionTokens).toBe(15);
  });

  test('window cuts off records outside the last N days', () => {
    writeFile('openai-2026-04-10.jsonl', [
      { ts: '2026-04-10T10:00:00Z', provider: 'openai', model: 'm', total_tokens: 999, latency_ms: 0 },
    ]);
    writeFile('openai-2026-04-17.jsonl', [
      { ts: '2026-04-17T10:00:00Z', provider: 'openai', model: 'm', total_tokens: 5, latency_ms: 0 },
    ]);
    const snap = computeCostSnapshot({
      dir,
      days: 3,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(snap.totalTokens).toBe(5);
    expect(snap.filesScanned).toBe(1);
  });

  test('tolerates records with missing provider or model — silently skipped', () => {
    writeFile('openai-2026-04-17.jsonl', [
      { ts: '2026-04-17T10:00:00Z', provider: 'openai', model: 'm', total_tokens: 10, latency_ms: 0 },
      { ts: '2026-04-17T11:00:00Z', total_tokens: 999 }, // no provider/model
    ]);
    const snap = computeCostSnapshot({
      dir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(snap.totalRequests).toBe(1);
    expect(snap.totalTokens).toBe(10);
  });
});

async function connected() {
  const server = buildNovaMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

describe('nova.ops.cost.snapshot — MCP tool surface', () => {
  test('advertised in listTools', async () => {
    const client = await connected();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain('nova.ops.cost.snapshot');
  });

  test('returns the aggregated snapshot JSON envelope', async () => {
    writeFile('openai-2026-04-18.jsonl', [
      {
        ts: new Date().toISOString(),
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        latency_ms: 100,
      },
    ]);
    const client = await connected();
    const result = await client.callTool({
      name: 'nova.ops.cost.snapshot',
      arguments: { days: 30, dir },
    });
    const parsed = JSON.parse(textOf(result)) as {
      totalRequests: number;
      totalTokens: number;
      byProvider: Array<{ key: string; totalTokens: number }>;
      byModel: Array<{ key: string }>;
    };
    expect(parsed.totalRequests).toBe(1);
    expect(parsed.totalTokens).toBe(15);
    expect(parsed.byProvider[0]!.key).toBe('openai');
    expect(parsed.byModel[0]!.key).toBe('openai/gpt-4o');
  });
});
