import { describe, expect, test } from 'bun:test';
import { buildPlannerPrompt } from '../src/planner/prompt.js';
import type { PlannerToolDescriptor } from '../src/planner/schema.js';

const fixtureTools: PlannerToolDescriptor[] = [
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
  {
    name: 'sirius.providers.deregister',
    description: 'Remove a provider from the gateway registry.',
    inputSchema: { type: 'object' },
    tier: 'mutation-destructive',
  },
];

describe('buildPlannerPrompt', () => {
  test('system message carries the rules and the available-tools block', () => {
    const { systemMessage } = buildPlannerPrompt({
      tools: fixtureTools,
      context: '',
      goal: 'x',
    });
    expect(systemMessage).toContain('operator-automation planner');
    expect(systemMessage).toContain('submit_plan');
    expect(systemMessage).toContain('at most 20 steps');
    expect(systemMessage).toContain('AVAILABLE TOOLS:');
    // each tool name + its tier tag shows up verbatim
    expect(systemMessage).toContain('`llamactl.catalog.list` [READ]');
    expect(systemMessage).toContain(
      '`llamactl.catalog.promote` [MUTATION (dry-run-safe)]',
    );
    expect(systemMessage).toContain(
      '`sirius.providers.deregister` [MUTATION (destructive)]',
    );
  });

  test('empty tool list renders `(none)` — no dangling "AVAILABLE TOOLS:" header', () => {
    const { systemMessage } = buildPlannerPrompt({
      tools: [],
      context: '',
      goal: 'x',
    });
    expect(systemMessage).toContain('AVAILABLE TOOLS:\n(none)');
  });

  test('user message includes context + goal, with sane fallback when context empty', () => {
    const withCtx = buildPlannerPrompt({
      tools: fixtureTools,
      context: 'node gpu1: down for 3m',
      goal: 'fix gpu1',
    });
    expect(withCtx.userMessage).toContain('FLEET CONTEXT:\nnode gpu1: down for 3m');
    expect(withCtx.userMessage).toContain('GOAL:\nfix gpu1');

    const noCtx = buildPlannerPrompt({
      tools: fixtureTools,
      context: '   ',
      goal: 'do the thing',
    });
    expect(noCtx.userMessage).toContain('FLEET CONTEXT:\n(no context supplied)');
    expect(noCtx.userMessage).toContain('GOAL:\ndo the thing');
  });

  test('submit_plan function schema is OAI-compatible and enforces maxItems=20', () => {
    const { submitPlanFunction } = buildPlannerPrompt({
      tools: fixtureTools,
      context: '',
      goal: '',
    });
    expect(submitPlanFunction.name).toBe('submit_plan');
    expect(submitPlanFunction.description.length).toBeGreaterThan(0);
    const params = submitPlanFunction.parameters as Record<string, unknown>;
    expect(params.type).toBe('object');
    expect(params.required).toEqual(['steps', 'reasoning']);
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.steps.type).toBe('array');
    expect(props.steps.maxItems).toBe(20);
    const stepItems = props.steps.items as Record<string, unknown>;
    expect(stepItems.required).toEqual(['tool', 'annotation']);
    const stepProps = stepItems.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(stepProps).sort()).toEqual([
      'annotation',
      'args',
      'dryRun',
      'tool',
    ]);
  });

  test('is deterministic — same inputs produce byte-identical output', () => {
    const a = buildPlannerPrompt({
      tools: fixtureTools,
      context: 'ctx',
      goal: 'goal',
    });
    const b = buildPlannerPrompt({
      tools: fixtureTools,
      context: 'ctx',
      goal: 'goal',
    });
    expect(a.systemMessage).toBe(b.systemMessage);
    expect(a.userMessage).toBe(b.userMessage);
    expect(JSON.stringify(a.submitPlanFunction)).toBe(
      JSON.stringify(b.submitPlanFunction),
    );
  });
});
