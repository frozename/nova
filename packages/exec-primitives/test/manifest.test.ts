import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PACKAGE_NAME, releaseProblems, TAG_PREFIX } from "../scripts/release-check.ts";

const PACKAGE_DIR = dirname(import.meta.dir);

function readManifest(): Record<string, unknown> {
  const text = readFileSync(join(PACKAGE_DIR, "package.json"), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

const publishable = {
  name: PACKAGE_NAME,
  version: "1.2.3",
  publishConfig: { access: "public" },
};

describe("package manifest", () => {
  test("declares no runtime dependencies", () => {
    const manifest = readManifest();
    expect(manifest["dependencies"]).toBeUndefined();
    expect(manifest["peerDependencies"]).toBeUndefined();
    expect(manifest["optionalDependencies"]).toBeUndefined();
  });

  test("passes the release preflight once the private field is removed", () => {
    const { private: _private, ...rest } = readManifest();
    expect(releaseProblems(`${TAG_PREFIX}${String(rest["version"])}`, rest)).toEqual([]);
  });
});

describe("release preflight", () => {
  test("accepts a tag naming the manifest version of a publishable manifest", () => {
    expect(releaseProblems("exec-primitives-v1.2.3", publishable)).toEqual([]);
  });

  test("refuses a manifest that still has a private field, whatever its value", () => {
    for (const value of [true, false]) {
      const problems = releaseProblems("exec-primitives-v1.2.3", {
        ...publishable,
        private: value,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('"private"');
    }
  });

  test("refuses a tag whose version differs from the manifest version", () => {
    const problems = releaseProblems("exec-primitives-v1.2.4", publishable);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"1.2.4"');
  });

  test("refuses a missing, bare, or foreign tag", () => {
    for (const tag of [undefined, "", "exec-primitives-v", "v1.2.3", "contracts-v1.2.3"]) {
      expect(releaseProblems(tag, publishable)).toHaveLength(1);
    }
  });

  test("refuses a foreign package name and a non-public publishConfig", () => {
    expect(
      releaseProblems("exec-primitives-v1.2.3", { ...publishable, name: "other" }),
    ).toHaveLength(1);
    expect(
      releaseProblems("exec-primitives-v1.2.3", { ...publishable, publishConfig: null }),
    ).toHaveLength(1);
    expect(
      releaseProblems("exec-primitives-v1.2.3", {
        ...publishable,
        publishConfig: { access: "restricted" },
      }),
    ).toHaveLength(1);
  });
});
