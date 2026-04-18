import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { buildNovaMcpServer } from '../src/server.js';

/**
 * Smoke test for @nova/mcp. Boots the facade over the SDK's
 * InMemoryTransport, exercises `ops.overview` against a tempdir-scoped
 * trio of YAMLs, and verifies `ops.healthcheck` fails soft when a
 * gateway endpoint is unreachable.
 */

let runtimeDir = '';
let auditDir = '';
let kubePath = '';
let siriusPath = '';
let embPath = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'nova-mcp-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'nova-mcp-audit-'));
  kubePath = join(runtimeDir, 'config');
  siriusPath = join(runtimeDir, 'sirius-providers.yaml');
  embPath = join(runtimeDir, 'embersynth.yaml');

  writeFileSync(
    kubePath,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [
            { name: 'local', endpoint: 'inproc://local' },
            {
              name: 'sirius-primary',
              endpoint: '',
              kind: 'gateway',
              cloud: { provider: 'sirius', baseUrl: 'http://127.0.0.1:1/v1' },
            },
          ],
        },
      ],
      users: [{ name: 'me', token: 'local' }],
    }),
  );
  writeFileSync(
    siriusPath,
    stringifyYaml({
      providers: [
        { name: 'openai', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1' },
      ],
    }),
  );
  writeFileSync(
    embPath,
    stringifyYaml({
      profiles: [{ id: 'auto', label: 'Automatic' }],
      syntheticModels: { 'fusion-auto': 'auto' },
    }),
  );

  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
  });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
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

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.startsWith('nova-'));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), 'utf8');
    for (const line of body.trim().split('\n')) if (line) out.push(JSON.parse(line));
  }
  return out;
}

describe('@nova/mcp facade', () => {
  test('listTools advertises the two roll-up tools', async () => {
    const client = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual(['nova.ops.healthcheck', 'nova.ops.overview']);
  });

  test('nova.ops.overview unifies kubeconfig + sirius + embersynth', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'nova.ops.overview',
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      context: string | null;
      cluster: string | null;
      agents: Array<{ name: string }>;
      gateways: Array<{ name: string; provider: string | null }>;
      siriusProviders: Array<{ name: string; kind: string }>;
      embersynthProfiles: Array<{ id: string }>;
      syntheticModels: Record<string, string>;
    };
    expect(parsed.context).toBe('default');
    expect(parsed.cluster).toBe('home');
    expect(parsed.agents.map((a) => a.name)).toEqual(['local']);
    expect(parsed.gateways.map((g) => g.name)).toEqual(['sirius-primary']);
    expect(parsed.siriusProviders.map((p) => p.name)).toEqual(['openai']);
    expect(parsed.embersynthProfiles.map((p) => p.id)).toEqual(['auto']);
    expect(parsed.syntheticModels['fusion-auto']).toBe('auto');

    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('nova.ops.overview');
  });

  test('nova.ops.overview surfaces empty sections when files are absent', async () => {
    rmSync(kubePath);
    rmSync(siriusPath);
    rmSync(embPath);
    const client = await connected();
    const result = await client.callTool({
      name: 'nova.ops.overview',
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      paths: { kubeconfig: string | null; siriusProviders: string | null; embersynthConfig: string | null };
      agents: unknown[];
      gateways: unknown[];
      siriusProviders: unknown[];
      embersynthProfiles: unknown[];
      syntheticModels: Record<string, string>;
    };
    expect(parsed.paths.kubeconfig).toBeNull();
    expect(parsed.paths.siriusProviders).toBeNull();
    expect(parsed.paths.embersynthConfig).toBeNull();
    expect(parsed.agents).toEqual([]);
    expect(parsed.gateways).toEqual([]);
    expect(parsed.siriusProviders).toEqual([]);
    expect(parsed.embersynthProfiles).toEqual([]);
    expect(parsed.syntheticModels).toEqual({});
  });

  test('nova.ops.healthcheck fails soft on unreachable endpoints', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'nova.ops.healthcheck',
      arguments: { timeoutMs: 500 },
    });
    const parsed = JSON.parse(textOf(result)) as {
      gateways: Array<{ name: string; ok: boolean; status: number }>;
      siriusProviders: Array<{ name: string; ok: boolean; status: number }>;
    };
    expect(parsed.gateways).toHaveLength(1);
    expect(parsed.gateways[0]!.name).toBe('sirius-primary');
    expect(parsed.gateways[0]!.ok).toBe(false);
    expect(parsed.siriusProviders).toHaveLength(1);
    expect(parsed.siriusProviders[0]!.ok).toBe(false);

    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('nova.ops.healthcheck');
  });
});
