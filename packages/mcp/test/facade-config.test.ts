import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/facade/config.js';

/**
 * Covers the facade YAML loader at `src/facade/config.ts`.
 *  - valid v1 with stdio + http downstreams
 *  - bad version throws (Zod refusal)
 *  - env interpolation replaces known vars and leaves unknown
 *    literal (as a visible breadcrumb, not a silent empty string)
 *  - missing file returns null
 *  - malformed YAML throws
 */

let workDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nova-mcp-cfg-'));
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(workDir, { recursive: true, force: true });
});

function writeCfg(name: string, body: string): string {
  const p = join(workDir, name);
  writeFileSync(p, body);
  return p;
}

describe('facade/config loadConfig', () => {
  test('loads a valid v1 config with stdio + http downstreams', () => {
    const path = writeCfg(
      'ok.yaml',
      `version: 1
downstreams:
  - name: llamactl
    transport: stdio
    command: llamactl-mcp
    args: []
  - name: sirius
    transport: http
    url: http://127.0.0.1:4401/mcp
    token: tok-abc
`,
    );
    const cfg = loadConfig({ path });
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(1);
    expect(cfg!.downstreams).toHaveLength(2);
    const stdio = cfg!.downstreams[0]!;
    expect(stdio.name).toBe('llamactl');
    expect(stdio.transport).toBe('stdio');
    if (stdio.transport === 'stdio') {
      expect(stdio.command).toBe('llamactl-mcp');
      expect(stdio.args).toEqual([]);
    }
    const http = cfg!.downstreams[1]!;
    expect(http.name).toBe('sirius');
    expect(http.transport).toBe('http');
    if (http.transport === 'http') {
      expect(http.url).toBe('http://127.0.0.1:4401/mcp');
      expect(http.token).toBe('tok-abc');
    }
  });

  test('bad version throws', () => {
    const path = writeCfg(
      'badver.yaml',
      `version: 2
downstreams: []
`,
    );
    expect(() => loadConfig({ path })).toThrow();
  });

  test('env interpolation replaces known vars and leaves missing literal', () => {
    process.env.KNOWN = 'resolved-value';
    delete process.env.MISSING;
    const path = writeCfg(
      'interp.yaml',
      `version: 1
downstreams:
  - name: a
    transport: http
    url: http://example.com/mcp
    token: \${KNOWN}
  - name: b
    transport: stdio
    command: some-mcp
    args: []
    env:
      MISSING_VAR: \${MISSING}
`,
    );
    const cfg = loadConfig({ path });
    expect(cfg).not.toBeNull();
    const http = cfg!.downstreams[0]!;
    if (http.transport === 'http') {
      expect(http.token).toBe('resolved-value');
    }
    const stdio = cfg!.downstreams[1]!;
    if (stdio.transport === 'stdio') {
      expect(stdio.env?.MISSING_VAR).toBe('${MISSING}');
    }
  });

  test('missing file returns null', () => {
    const cfg = loadConfig({ path: join(workDir, 'does-not-exist.yaml') });
    expect(cfg).toBeNull();
  });

  test('malformed YAML throws', () => {
    const path = writeCfg('bad.yaml', ': : : not valid yaml [\n');
    expect(() => loadConfig({ path })).toThrow();
  });
});
