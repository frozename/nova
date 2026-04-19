import { describe, expect, test } from 'bun:test';
import { PlanSchema, PlanStepSchema } from '../src/planner/schema.js';

describe('PlanStepSchema', () => {
  test('accepts a well-formed read step', () => {
    const parsed = PlanStepSchema.parse({
      tool: 'llamactl.catalog.list',
      args: { classFilter: 'multimodal' },
      annotation: 'list multimodal candidates',
    });
    expect(parsed.tool).toBe('llamactl.catalog.list');
    expect(parsed.args).toEqual({ classFilter: 'multimodal' });
    expect(parsed.annotation).toBe('list multimodal candidates');
    // default-empty args when omitted:
    const noArgs = PlanStepSchema.parse({
      tool: 'nova.ops.overview',
      annotation: 'snapshot the fleet',
    });
    expect(noArgs.args).toEqual({});
  });

  test('rejects empty tool name', () => {
    expect(() =>
      PlanStepSchema.parse({ tool: '', annotation: 'x' }),
    ).toThrow();
  });

  test('rejects missing annotation (forces the model to justify each step)', () => {
    expect(() =>
      PlanStepSchema.parse({ tool: 'llamactl.catalog.list' }),
    ).toThrow();
  });
});

describe('PlanSchema', () => {
  test('requires at least reasoning + steps; requiresConfirmation defaults true', () => {
    const parsed = PlanSchema.parse({
      steps: [{ tool: 'llamactl.catalog.list', annotation: 'read' }],
      reasoning: 'listing',
    });
    expect(parsed.requiresConfirmation).toBe(true);
  });

  test('rejects plans over the 20-step hard cap', () => {
    const step = { tool: 'x.y', annotation: 'z' };
    expect(() =>
      PlanSchema.parse({
        steps: Array.from({ length: 21 }, () => step),
        reasoning: 'too many',
      }),
    ).toThrow(/20-step hard cap/);
  });

  test('accepts exactly 20 steps', () => {
    const step = { tool: 'x.y', annotation: 'z' };
    const parsed = PlanSchema.parse({
      steps: Array.from({ length: 20 }, () => step),
      reasoning: 'boundary',
    });
    expect(parsed.steps).toHaveLength(20);
  });

  test('requires non-empty reasoning', () => {
    expect(() =>
      PlanSchema.parse({
        steps: [{ tool: 'x', annotation: 'y' }],
        reasoning: '',
      }),
    ).toThrow();
  });
});
