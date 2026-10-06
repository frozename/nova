import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("no-cross-package-relative lint", () => {
  const SCRIPT = join(import.meta.dir, "no-cross-package-relative.ts");
  const fixtureRoot = join(tmpdir(), `no-cross-package-relative-${crypto.randomUUID()}`);

  function run(paths: string): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, "--paths", paths],
      env: {
        ...process.env,
        NOVA_LINT_NO_CROSS_PACKAGE_RELATIVE_ROOT: fixtureRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout).trim(),
      stderr: new TextDecoder().decode(result.stderr).trim(),
    };
  }

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function writeFixture(rel: string, body: string): Promise<void> {
    const dir = join(fixtureRoot, rel.split("/").slice(0, -1).join("/"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path derived from a constant tmpdir root, not user input.
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(fixtureRoot, rel), body);
  }

  test("flags static cross-package relative imports", async () => {
    await writeFixture(
      "packages/mcp/src/server.ts",
      'import { toTextContent } from "../../../mcp-shared/src/content.js";\n',
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/mcp/src/server.ts:1");
    expect(result.stderr).toContain("../../../mcp-shared/src/content.js");
  });

  test("flags dynamic import() escapes", async () => {
    await writeFixture(
      "packages/mcp-shared/src/pricing.ts",
      'const mod = await import("../../../contracts/src/schemas/pricing.js");\n',
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("../../../contracts/src/schemas/pricing.js");
  });

  test("flags require()/createRequire escapes", async () => {
    await writeFixture(
      "packages/mcp/src/cost/snapshot.ts",
      'const { x } = createRequire(import.meta.url)("../../../contracts/src/index.js");\n',
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("../../../contracts/src/index.js");
  });

  test("flags import.meta.dir/__dirname path-climb into a sibling package", async () => {
    await writeFixture(
      "packages/mcp/src/boot.ts",
      [
        "const DEFAULT_WORKER_ENTRY = pathResolve(",
        "  import.meta.dir,",
        '  "..",',
        '  "..",',
        '  "..",',
        '  "mcp-shared",',
        '  "bin",',
        '  "worker.ts",',
        ");",
        "",
      ].join("\n"),
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/mcp/src/boot.ts:1");
    expect(result.stderr).toContain("mcp-shared");
  });

  test("flags a single-line __dirname path-climb into a sibling package", async () => {
    await writeFixture(
      "packages/mcp/src/paths.ts",
      'const p = join(__dirname, "..", "..", "contracts", "bin", "x.ts");\n',
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("packages/mcp/src/paths.ts:1");
  });

  test("allows import.meta.resolve of a @novaproto/* package subpath", async () => {
    await writeFixture(
      "packages/mcp/src/boot.ts",
      [
        "const DEFAULT_WORKER_ENTRY = fileURLToPath(",
        '  import.meta.resolve("@novaproto/mcp-shared/worker"),',
        ");",
        "",
      ].join("\n"),
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no cross-package relative imports found");
  });

  test("allows an in-package .. resolve that does not name a sibling package", async () => {
    await writeFixture(
      "packages/mcp/src/facade/config.ts",
      'const dir = resolve(import.meta.dir, "..", "..", "templates");\n',
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no cross-package relative imports found");
  });

  test("allows @novaproto/* package specifiers and intra-package relatives", async () => {
    await writeFixture(
      "packages/mcp/src/server.ts",
      [
        'import { appendAudit, toTextContent } from "@novaproto/mcp-shared";',
        'import type { PricingCatalog } from "@novaproto/contracts";',
        'import { defaultNovaMcpConfigPath } from "./facade/config.js";',
        'const mod = await import("@novaproto/contracts");',
        "export const ok = true;",
        "",
      ].join("\n"),
    );

    const result = run("packages/*/src/**/*.ts");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no cross-package relative imports found");
  });
});
