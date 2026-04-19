import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALLOWLIST,
  filterTools,
  type AllowlistConfig,
} from '../src/planner/allowlist.js';
import type { PlannerToolDescriptor } from '../src/planner/schema.js';

function tool(
  name: string,
  tier: PlannerToolDescriptor['tier'] = 'read',
): PlannerToolDescriptor {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: { type: 'object' },
    tier,
  };
}

describe('filterTools', () => {
  test('empty allow list drops everything (fail-closed)', () => {
    const out = filterTools(
      [tool('llamactl.catalog.list'), tool('sirius.providers.list')],
      { allow: [], deny: [] },
    );
    expect(out).toEqual([]);
  });

  test('exact-match allow keeps only the named tool', () => {
    const out = filterTools(
      [tool('llamactl.catalog.list'), tool('sirius.providers.list')],
      { allow: ['llamactl.catalog.list'], deny: [] },
    );
    expect(out.map((t) => t.name)).toEqual(['llamactl.catalog.list']);
  });

  test('trailing-* glob matches any suffix', () => {
    const out = filterTools(
      [
        tool('llamactl.catalog.list'),
        tool('llamactl.infra.install', 'mutation-dry-run-safe'),
        tool('sirius.providers.list'),
      ],
      { allow: ['llamactl.*'], deny: [] },
    );
    expect(out.map((t) => t.name).sort()).toEqual([
      'llamactl.catalog.list',
      'llamactl.infra.install',
    ]);
  });

  test('deny wins over allow — "allow *.* but deny X"', () => {
    const out = filterTools(
      [
        tool('llamactl.catalog.list'),
        tool('llamactl.infra.uninstall', 'mutation-destructive'),
      ],
      {
        allow: ['llamactl.*'],
        deny: ['llamactl.infra.uninstall'],
        allowDestructive: true,
      },
    );
    expect(out.map((t) => t.name)).toEqual(['llamactl.catalog.list']);
  });

  test('destructive tier requires allowDestructive even when allow matches', () => {
    const tools = [
      tool('llamactl.infra.uninstall', 'mutation-destructive'),
      tool('llamactl.catalog.list', 'read'),
    ];
    const off = filterTools(tools, { allow: ['llamactl.*'], deny: [] });
    expect(off.map((t) => t.name)).toEqual(['llamactl.catalog.list']);

    const on = filterTools(tools, {
      allow: ['llamactl.*'],
      deny: [],
      allowDestructive: true,
    });
    expect(on.map((t) => t.name).sort()).toEqual([
      'llamactl.catalog.list',
      'llamactl.infra.uninstall',
    ]);
  });

  test('bare * allow does NOT auto-grant destructive', () => {
    const out = filterTools(
      [
        tool('llamactl.catalog.list'),
        tool('llamactl.infra.uninstall', 'mutation-destructive'),
      ],
      { allow: ['*'], deny: [] },
    );
    expect(out.map((t) => t.name)).toEqual(['llamactl.catalog.list']);
  });

  test('DEFAULT_ALLOWLIST keeps dry-run-safe mutations, blocks destructive ones by name', () => {
    const tools = [
      tool('llamactl.catalog.list', 'read'),
      tool('llamactl.infra.install', 'mutation-dry-run-safe'),
      tool('llamactl.infra.uninstall', 'mutation-destructive'),
      tool('sirius.providers.list', 'read'),
      tool('sirius.providers.deregister', 'mutation-destructive'),
      tool('embersynth.workloads.list', 'read'),
      tool('nova.ops.overview', 'read'),
    ];
    const names = filterTools(tools, DEFAULT_ALLOWLIST)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'embersynth.workloads.list',
      'llamactl.catalog.list',
      'llamactl.infra.install',
      'nova.ops.overview',
      'sirius.providers.list',
    ]);
  });

  test('glob prefix is literal — `llamactl.*` does not match `llamactlish.X`', () => {
    const out = filterTools(
      [tool('llamactlish.foo'), tool('llamactl.foo')],
      { allow: ['llamactl.*'], deny: [] },
    );
    expect(out.map((t) => t.name)).toEqual(['llamactl.foo']);
  });
});

describe('DEFAULT_ALLOWLIST shape', () => {
  test('does not allow destructive by default', () => {
    const cfg: AllowlistConfig = DEFAULT_ALLOWLIST;
    expect(cfg.allowDestructive).toBe(false);
  });
  test('includes known dangerous tools on the deny list', () => {
    expect(DEFAULT_ALLOWLIST.deny).toContain('sirius.providers.deregister');
    expect(DEFAULT_ALLOWLIST.deny).toContain('llamactl.infra.uninstall');
  });
});
