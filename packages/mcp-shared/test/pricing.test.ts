import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCost,
  estimateCostUsd,
  findModelPricing,
  loadPricing,
} from '../src/pricing.js';

let dir = '';

function writeFile(name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-pricing-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPricing', () => {
  test('returns empty result when dir does not exist', () => {
    const { catalog, filesLoaded, malformedFiles } = loadPricing({
      dir: join(dir, 'nope'),
    });
    expect(catalog.size).toBe(0);
    expect(filesLoaded).toEqual([]);
    expect(malformedFiles).toEqual([]);
  });

  test('loads validated YAML files into the catalog keyed by provider', () => {
    writeFile(
      'openai.yaml',
      `provider: openai
models:
  gpt-4o-mini:
    prompt_per_1k_tokens_usd: 0.00015
    completion_per_1k_tokens_usd: 0.0006
  gpt-4o:
    prompt_per_1k_tokens_usd: 0.0025
    completion_per_1k_tokens_usd: 0.010
`,
    );
    writeFile(
      'anthropic.yml',
      `provider: anthropic
models:
  claude-opus:
    prompt_per_1k_tokens_usd: 0.015
    completion_per_1k_tokens_usd: 0.075
`,
    );
    const { catalog, filesLoaded } = loadPricing({ dir });
    expect(catalog.size).toBe(2);
    expect(catalog.get('openai')!.models['gpt-4o']!.prompt_per_1k_tokens_usd).toBe(0.0025);
    expect(catalog.get('anthropic')!.models['claude-opus']!.completion_per_1k_tokens_usd).toBe(0.075);
    expect(filesLoaded).toHaveLength(2);
  });

  test('skips malformed YAML files (counted, not thrown)', () => {
    writeFile('openai.yaml', 'provider: openai\nmodels:\n  gpt-4o-mini:\n    prompt_per_1k_tokens_usd: 0.00015\n    completion_per_1k_tokens_usd: 0.0006\n');
    writeFile('broken.yaml', 'provider: [\n  not: yaml\n');
    writeFile('missing-fields.yaml', 'provider: together\nmodels: {}\n');
    const { catalog, malformedFiles, filesLoaded } = loadPricing({ dir });
    // openai and together load (together has an empty models map — valid).
    expect(catalog.has('openai')).toBe(true);
    expect(catalog.has('together')).toBe(true);
    expect(filesLoaded).toHaveLength(2);
    expect(malformedFiles).toHaveLength(1);
    expect(malformedFiles[0]!.path).toContain('broken.yaml');
  });

  test('ignores non-YAML files', () => {
    writeFile('notes.md', '# pricing notes');
    writeFile('openai.yaml', 'provider: openai\nmodels: {}\n');
    const { filesLoaded } = loadPricing({ dir });
    expect(filesLoaded).toHaveLength(1);
  });

  test('later file wins on duplicate provider slug', () => {
    writeFile(
      'a-openai.yaml',
      `provider: openai\nmodels:\n  x:\n    prompt_per_1k_tokens_usd: 1\n    completion_per_1k_tokens_usd: 1\n`,
    );
    writeFile(
      'b-openai.yaml',
      `provider: openai\nmodels:\n  x:\n    prompt_per_1k_tokens_usd: 9\n    completion_per_1k_tokens_usd: 9\n`,
    );
    const { catalog } = loadPricing({ dir });
    // readdir is sorted alphabetically, so b-openai.yaml loads last
    // and overwrites the a-openai entry.
    expect(catalog.get('openai')!.models.x!.prompt_per_1k_tokens_usd).toBe(9);
  });
});

describe('computeCost', () => {
  test('linear in both token streams', () => {
    const cost = computeCost(
      { prompt_per_1k_tokens_usd: 0.001, completion_per_1k_tokens_usd: 0.002 },
      1000,
      500,
    );
    // 1000/1000 * 0.001 + 500/1000 * 0.002 = 0.001 + 0.001 = 0.002
    expect(cost).toBeCloseTo(0.002, 10);
  });

  test('zero tokens = zero cost', () => {
    expect(
      computeCost(
        { prompt_per_1k_tokens_usd: 0.5, completion_per_1k_tokens_usd: 0.5 },
        0,
        0,
      ),
    ).toBe(0);
  });

  test('zero completion rate (embedding case)', () => {
    const cost = computeCost(
      { prompt_per_1k_tokens_usd: 0.00002, completion_per_1k_tokens_usd: 0 },
      100_000,
      0,
    );
    expect(cost).toBeCloseTo(100 * 0.00002, 10);
  });
});

describe('estimateCostUsd', () => {
  test('returns undefined when provider missing', () => {
    const cost = estimateCostUsd(
      {
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
      },
      new Map(),
    );
    expect(cost).toBeUndefined();
  });

  test('returns undefined when model missing from provider catalog', () => {
    writeFile(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    const { catalog } = loadPricing({ dir });
    const cost = estimateCostUsd(
      {
        provider: 'openai',
        model: 'gpt-2-preview',
        kind: 'chat',
        prompt_tokens: 10,
        completion_tokens: 5,
      },
      catalog,
    );
    expect(cost).toBeUndefined();
  });

  test('returns the joined cost when pricing is present', () => {
    writeFile(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    const { catalog } = loadPricing({ dir });
    const cost = estimateCostUsd(
      {
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'chat',
        prompt_tokens: 2000,
        completion_tokens: 1000,
      },
      catalog,
    );
    // 2*0.0025 + 1*0.010 = 0.005 + 0.010 = 0.015
    expect(cost).toBeCloseTo(0.015, 10);
  });
});

describe('findModelPricing', () => {
  test('returns rate entry + parent provider when both exist', () => {
    writeFile(
      'openai.yaml',
      `provider: openai\nmodels:\n  gpt-4o:\n    prompt_per_1k_tokens_usd: 0.0025\n    completion_per_1k_tokens_usd: 0.010\n`,
    );
    const { catalog } = loadPricing({ dir });
    const found = findModelPricing('openai', 'gpt-4o', catalog);
    expect(found).toBeDefined();
    expect(found!.provider.provider).toBe('openai');
    expect(found!.model.prompt_per_1k_tokens_usd).toBe(0.0025);
  });

  test('returns undefined when nothing matches', () => {
    expect(findModelPricing('openai', 'x', new Map())).toBeUndefined();
  });
});
