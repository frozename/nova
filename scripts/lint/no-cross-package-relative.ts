#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Finding = {
  file: string;
  line: number;
  match: string;
};

const ROOT = resolve(
  process.env["NOVA_LINT_NO_CROSS_PACKAGE_RELATIVE_ROOT"] ?? join(import.meta.dir, "../.."),
);
const DEFAULT_PATHS = ["packages/*/src/**/*.ts", "packages/*/bin/**/*.ts"];

// A cross-package escape is a RELATIVE specifier (starts with .) that reaches
// into a sibling package's src/ directory. The relative segment "../" is what
// breaks npm package isolation: published packages have no sibling src/ on disk.
// Match the specifier in any of the three forms that can carry one:
//   - static/`export ... from` "specifier"
//   - dynamic import("specifier")
//   - require("specifier") / createRequire(...)("specifier")
const PACKAGE_GROUP = "contracts|mcp-shared|mcp";
// A relative specifier reaching into a sibling package's src/ has no legitimate
// use in any position (static, dynamic, require, or createRequire(...)(...) ),
// so we match the quoted specifier itself rather than the surrounding keyword —
// keyword-anchored patterns miss createRequire(import.meta.url)("..."), where
// the string follows `)(` rather than a `require` token.
const SPECIFIER = `['"](\\.[^'"]*\\/(?:${PACKAGE_GROUP})\\/src\\/[^'"]*)['"]`;
const SPECIFIER_PATTERN = new RegExp(SPECIFIER, "g");

// Second class of cross-package escape: a FILESYSTEM PATH built from
// import.meta.dir / __dirname that climbs ("..") into a sibling PACKAGE dir,
// e.g. pathResolve(import.meta.dir, "..", "..", "..", "mcp-shared", "bin", ...).
// This is a runtime path computation, not an import specifier, so the SPECIFIER
// pattern above does not see it — yet it has the same failure mode: the sibling
// package source does not exist in a published install layout, so the path
// resolves to nothing and the module throws on import. Resolve via the sibling's
// @novaproto/* package (import.meta.resolve / require.resolve) instead.
//
// We match a path-builder call (resolve/join/pathResolve/path.join/path.resolve)
// that contains an import.meta.dir/__dirname anchor, at least one ".." climb
// segment, AND a quoted sibling-package-name segment. The `[^()]` runs span
// newlines (the negated class includes "\n"), so the multi-line one-arg-per-line
// formatting these calls commonly use is matched without the `s` flag. The
// PACKAGE_GROUP name must appear as its own quoted path segment ("mcp-shared")
// so we don't trip on substrings inside an unrelated identifier. The group is
// non-capturing — only match[0] (the whole call) is reported.
const PATH_CLIMB = new RegExp(
  // a path-builder call: resolve / join / pathResolve / path.resolve / path.join.
  // Allow any identifier chars / dot before the resolve|join verb (case-insensitive
  // on the boundary letter) so pathResolve and path.join are both caught.
  `[A-Za-z_$.]*(?:[Rr]esolve|[Jj]oin)\\s*\\(` +
    `[^()]*?(?:import\\.meta\\.dir|__dirname)` + // anchored at the module dir
    `[^()]*?['"]\\.\\.['"]` + // with at least one ".." climb arg
    `[^()]*?['"](?:${PACKAGE_GROUP})['"]` + // naming a sibling package dir
    `[^()]*?\\)`,
  "g",
);

function readArgs(argv: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--paths") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--paths requires a glob");
      }
      paths.push(value);
      continue;
    }
    throw new Error(`unknown arg: ${String(arg)}`);
  }
  return paths.length ? paths : DEFAULT_PATHS;
}

function scanSpecifiers(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  for (const [lineIdx, line] of lines.entries()) {
    SPECIFIER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER_PATTERN.exec(line)) !== null) {
      findings.push({ file, line: lineIdx + 1, match: match[1] ?? match[0] });
    }
  }
  return findings;
}

function scanPathClimbs(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  PATH_CLIMB.lastIndex = 0;
  let climb: RegExpExecArray | null;
  while ((climb = PATH_CLIMB.exec(source)) !== null) {
    const lineNo = source.slice(0, climb.index).split(/\r?\n/).length;
    const flat = climb[0].replaceAll(/\s+/g, " ").trim();
    findings.push({ file, line: lineNo, match: flat });
  }
  return findings;
}

function scan(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of paths) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
      const normalized = rel.split("\\").join("/");
      if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) {
        continue;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading the lint targets is this script's purpose; paths come from the repo glob, not user input.
      const source = readFileSync(join(ROOT, rel), "utf8");
      findings.push(...scanSpecifiers(source, normalized), ...scanPathClimbs(source, normalized));
    }
  }
  return findings;
}

function main(): void {
  const paths = readArgs(process.argv.slice(2));
  const findings = scan(paths);

  if (findings.length === 0) {
    process.stdout.write("no cross-package relative imports found\n");
    process.exit(0);
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${String(finding.line)} ${finding.match}`);
  }

  const count = findings.length;
  console.error(
    `error: found ${String(count)} cross-package escape${count === 1 ? "" : "s"} ` +
      `(relative import or import.meta.dir/__dirname path-climb into a sibling package); ` +
      `resolve via the sibling's @novaproto/* package specifier instead`,
  );
  process.exit(1);
}

main();
