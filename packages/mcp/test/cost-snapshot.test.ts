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

describe('computeCostSnapshot — pricing join (N.3.4)', () => {
  let pricingDir = '';

  beforeEach(() => {
    pricingDir = mkdtempSync(join(tmpdir(), 'nova-pricing-'));
  });
  afterEach(() => {
    rmSync(pricingDir, { recursive: true, force: true });
  });

  function writePricing(name: string, body: string): void {
    writeFileSync(join(pricingDir, name), body);
  }

  test('rolls up estimated_cost_usd when pricing matches', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 2000,
        completion_tokens: 1000,
        total_tokens: 3000,
        latency_ms: 500,
      },
      {
        ts: '2026-04-17T11:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 4000,
        completion_tokens: 2000,
        total_tokens: 6000,
        latency_ms: 800,
      },
    ]);
    writePricing(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    const snap = computeCostSnapshot({
      dir,
      pricingDir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    // record 1: 2*0.0025 + 1*0.010 = 0.015
    // record 2: 4*0.0025 + 2*0.010 = 0.030
    // total:   0.045
    expect(snap.totalEstimatedCostUsd).toBeCloseTo(0.045, 10);
    expect(snap.recordsMissingPricing).toBe(0);
    expect(snap.pricingFilesLoaded).toBe(1);
    const openai = snap.byProvider.find((g) => g.key === 'openai')!;
    expect(openai.estimatedCostUsd).toBeCloseTo(0.045, 10);
    expect(openai.recordsMissingPricing).toBe(0);
  });

  test('records without matching pricing leave group cost blank + bump missing counter', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        latency_ms: 100,
      },
    ]);
    writeFile('anthropic-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T11:00:00Z',
        provider: 'anthropic',
        model: 'claude-opus',
        kind: 'chat',
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        latency_ms: 200,
      },
    ]);
    writePricing(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    // No anthropic.yaml — claude-opus record has no pricing.
    const snap = computeCostSnapshot({
      dir,
      pricingDir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    // Only the openai record contributes to cost.
    expect(snap.totalEstimatedCostUsd).toBeCloseTo(0.0025 + 0.005, 10);
    expect(snap.recordsMissingPricing).toBe(1);
    const openai = snap.byProvider.find((g) => g.key === 'openai')!;
    const anthropic = snap.byProvider.find((g) => g.key === 'anthropic')!;
    expect(openai.estimatedCostUsd).toBeCloseTo(0.0075, 10);
    expect(openai.recordsMissingPricing).toBe(0);
    expect(anthropic.estimatedCostUsd).toBeUndefined();
    expect(anthropic.recordsMissingPricing).toBe(1);
  });

  test('empty pricing dir → snapshot still runs, all costs undefined', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        latency_ms: 100,
      },
    ]);
    const snap = computeCostSnapshot({
      dir,
      pricingDir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(snap.totalEstimatedCostUsd).toBeUndefined();
    expect(snap.recordsMissingPricing).toBe(1);
    expect(snap.pricingFilesLoaded).toBe(0);
    expect(snap.byProvider[0]!.estimatedCostUsd).toBeUndefined();
  });

  test('pricingDir=null disables pricing lookup entirely', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        latency_ms: 100,
      },
    ]);
    // Even with pricing on disk, null short-circuits.
    writePricing(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    const snap = computeCostSnapshot({
      dir,
      pricingDir: null,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    expect(snap.totalEstimatedCostUsd).toBeUndefined();
    expect(snap.pricingFilesLoaded).toBe(0);
  });

  test('injected catalog bypasses disk entirely', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        latency_ms: 100,
      },
    ]);
    const catalog = new Map();
    catalog.set('openai', {
      provider: 'openai',
      models: {
        'gpt-4o': {
          prompt_per_1k_tokens_usd: 0.01,
          completion_per_1k_tokens_usd: 0.02,
        },
      },
    });
    const snap = computeCostSnapshot({
      dir,
      pricing: catalog,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    // 1*0.01 + 0.5*0.02 = 0.02
    expect(snap.totalEstimatedCostUsd).toBeCloseTo(0.02, 10);
    expect(snap.pricingFilesLoaded).toBe(0); // no disk touched
  });

  test('groups sort by cost desc when costs exist, falling back to tokens on ties', () => {
    writeFile('openai-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        latency_ms: 100,
      },
    ]);
    writeFile('anthropic-2026-04-17.jsonl', [
      {
        ts: '2026-04-17T11:00:00Z',
        provider: 'anthropic',
        model: 'claude-opus',
        kind: 'chat',
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300,
        latency_ms: 200,
      },
    ]);
    // openai gets pricing; anthropic doesn't.
    writePricing(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 100\n    completion_per_1k_tokens_usd: 100\n`,
    );
    const snap = computeCostSnapshot({
      dir,
      pricingDir,
      days: 7,
      now: () => new Date('2026-04-18T00:00:00Z'),
    });
    // openai cost > 0, anthropic undefined (treated as -1 in sort) —
    // openai wins regardless of token totals.
    expect(snap.byProvider[0]!.key).toBe('openai');
    expect(snap.byProvider[1]!.key).toBe('anthropic');
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
