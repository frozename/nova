import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNovaMcpServer } from '../src/server.js';
import {
  runPlanner,
  stubPlannerExecutor,
  type PlannerExecutor,
} from '../src/planner/executor.js';
import type { PlannerToolDescriptor } from '../src/planner/schema.js';

/**
 * End-to-end tests for `nova.operator.plan`. Booted over the SDK's
 * InMemoryTransport — identical shape to the stdio deployment minus
 * the process boundary. Asserts:
 *   - canned stub produces a valid PlanSchema-shaped response,
 *   - injected executors drive the plan shape,
 *   - schema-invalid executor output fails closed (no bypass), and
 *   - audit entries land with the expected outcome fields.
 */

let auditDir = '';
let runtimeDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'nova-plan-rt-'));
  auditDir = mkdtempSync(join(tmpdir(), 'nova-plan-audit-'));
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

async function connected(serverOpts: Parameters<typeof buildNovaMcpServer>[0] = {}) {
  const server = buildNovaMcpServer(serverOpts);
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

const sampleTools: PlannerToolDescriptor[] = [
  {
    name: 'llamactl.catalog.list',
    description: 'List curated models on the target node.',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
  {
    name: 'llamactl.catalog.promote',
    description: 'Promote a model to a preset.',
    inputSchema: { type: 'object' },
    tier: 'mutation-dry-run-safe',
  },
];

describe('nova.operator.plan — MCP tool surface', () => {
  test('listTools advertises operator.plan alongside the existing ops tools', async () => {
    const client = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'nova.operator.plan',
      'nova.ops.cost.snapshot',
      'nova.ops.healthcheck',
      'nova.ops.overview',
    ]);
    const plan = list.tools.find((t) => t.name === 'nova.operator.plan')!;
    expect(plan.description).toContain('PlanSchema');
  });

  test('default stub executor returns a valid Plan wrapped in the MCP envelope', async () => {
    const client = await connected({ plannerTools: sampleTools });
    const result = await client.callTool({
      name: 'nova.operator.plan',
      arguments: { goal: 'promote the fastest multimodal model' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      executor: string;
      toolsAvailable: string[];
      plan: { steps: Array<{ tool: string; annotation: string }>; reasoning: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.executor).toBe('stub');
    // stub returns nova.ops.overview regardless of goal
    expect(parsed.plan.steps).toHaveLength(1);
    expect(parsed.plan.steps[0]!.tool).toBe('nova.ops.overview');
    expect(parsed.plan.steps[0]!.annotation.length).toBeGreaterThan(0);
    expect(parsed.plan.reasoning.length).toBeGreaterThan(0);
  });

  test('injected executor drives plan shape; audit records step count + executor name', async () => {
    const customExecutor: PlannerExecutor = {
      name: 'fake-gpt',
      async generate() {
        return {
          ok: true,
          rawPlan: {
            steps: [
              {
                tool: 'llamactl.catalog.list',
                args: { classFilter: 'multimodal' },
                annotation: 'list multimodal candidates',
              },
              {
                tool: 'llamactl.catalog.promote',
                args: { profile: 'macbook-pro-48g', preset: 'vision' },
                dryRun: true,
                annotation: 'dry-run promote the best candidate to vision',
              },
            ],
            reasoning: 'read + dry-run-mutation, standard two-step flow',
            requiresConfirmation: true,
          },
        };
      },
    };
    const client = await connected({
      plannerTools: sampleTools,
      plannerExecutor: customExecutor,
    });
    const result = await client.callTool({
      name: 'nova.operator.plan',
      arguments: { goal: 'promote the fastest multimodal model' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      executor: string;
      plan: { steps: Array<{ tool: string; dryRun?: boolean }>; requiresConfirmation: boolean };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.executor).toBe('fake-gpt');
    expect(parsed.plan.steps.map((s) => s.tool)).toEqual([
      'llamactl.catalog.list',
      'llamactl.catalog.promote',
    ]);
    expect(parsed.plan.steps[1]!.dryRun).toBe(true);
    expect(parsed.plan.requiresConfirmation).toBe(true);

    const audits = auditLines();
    const planAudit = audits.find((a) => a.tool === 'nova.operator.plan')!;
    const auditResult = planAudit.result as { outcome: string; executor: string; stepCount: number };
    expect(auditResult.outcome).toBe('ok');
    expect(auditResult.executor).toBe('fake-gpt');
    expect(auditResult.stepCount).toBe(2);
  });

  test('schema-invalid executor output fails closed — no bypass to operator', async () => {
    const badExecutor: PlannerExecutor = {
      name: 'broken',
      async generate() {
        return {
          ok: true,
          rawPlan: {
            // missing `annotation` on the step — should fail Zod
            steps: [{ tool: 'llamactl.catalog.list' }],
            reasoning: 'bad shape',
          },
        };
      },
    };
    const client = await connected({
      plannerTools: sampleTools,
      plannerExecutor: badExecutor,
    });
    const result = await client.callTool({
      name: 'nova.operator.plan',
      arguments: { goal: 'anything' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      reason: string;
      message: string;
      executor: string;
      rawPlan: unknown;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('plan-shape-invalid');
    expect(parsed.executor).toBe('broken');
    expect(parsed.rawPlan).toBeDefined();

    const audits = auditLines();
    const planAudit = audits.find((a) => a.tool === 'nova.operator.plan')!;
    const auditResult = planAudit.result as { outcome: string; reason: string };
    expect(auditResult.outcome).toBe('failed');
    expect(auditResult.reason).toBe('plan-shape-invalid');
  });

  test('executor reports a hard failure → surfaces as executor-failed', async () => {
    const failingExecutor: PlannerExecutor = {
      name: 'flaky',
      async generate() {
        return {
          ok: false,
          reason: 'model-error',
          message: 'upstream 503',
        };
      },
    };
    const client = await connected({ plannerExecutor: failingExecutor });
    const result = await client.callTool({
      name: 'nova.operator.plan',
      arguments: { goal: 'anything' },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason: string; message: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('executor-failed');
    expect(parsed.message).toContain('model-error');
    expect(parsed.message).toContain('upstream 503');
  });

  test('empty goal returns structured empty-goal failure (not an uncaught throw)', async () => {
    const client = await connected();
    // MCP may or may not enforce z.string().min(1) at the transport
    // boundary depending on SDK version. Either way the runPlanner
    // guard must fail closed — whitespace-only goals produce a
    // structured response the operator can act on.
    const result = await client.callTool({
      name: 'nova.operator.plan',
      arguments: { goal: '   ' },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('empty-goal');
  });
});

describe('runPlanner — pure composition', () => {
  test('empty goal short-circuits without invoking the executor', async () => {
    let called = 0;
    const exec: PlannerExecutor = {
      name: 'counter',
      async generate() {
        called++;
        return { ok: true, rawPlan: {} };
      },
    };
    const result = await runPlanner({
      goal: '   ',
      context: '',
      tools: sampleTools,
      executor: exec,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty-goal');
    expect(called).toBe(0);
  });

  test('stub executor is the default when no executor is supplied', async () => {
    const result = await runPlanner({
      goal: 'something',
      context: '',
      tools: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executor).toBe('stub');
    expect(result.plan.steps).toHaveLength(1);
  });

  test('stub executor exported via public API — operators can re-use', async () => {
    expect(stubPlannerExecutor.name).toBe('stub');
    const res = await stubPlannerExecutor.generate({
      systemMessage: 's',
      userMessage: 'u',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: [],
    });
    expect(res.ok).toBe(true);
  });
});
