import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  configBaseDir,
  defaultEmbersynthConfigPath,
  defaultKubeconfigPath,
  defaultSiriusProvidersPath,
} from "../src/paths.js";

/**
 * Pins the env-override resolution in `src/paths.ts`.
 *  - DEV_STORAGE (trimmed) moves the config root; unset or blank falls
 *    back to ~/.llamactl and never yields ""
 *  - each file path honors its own override (trimmed); a blank override
 *    falls through to <root>/<file>
 *  - the three overrides are independent, and none moves configBaseDir
 *    (server.ts uses it as the containment root for agent-supplied paths)
 * Every case passes an explicit env object, so process.env is never read
 * or mutated. The home default is computed with homedir() + join, as the
 * module does, so nothing depends on the machine's real home dir.
 */

const HOME_BASE = join(homedir(), ".llamactl");

interface FileRow {
  file: string;
  name: string;
  resolve: (env: NodeJS.ProcessEnv) => string;
  variable: string;
}

const FILE_ROWS: FileRow[] = [
  {
    file: "config",
    name: "defaultKubeconfigPath",
    resolve: defaultKubeconfigPath,
    variable: "LLAMACTL_CONFIG",
  },
  {
    file: "sirius-providers.yaml",
    name: "defaultSiriusProvidersPath",
    resolve: defaultSiriusProvidersPath,
    variable: "LLAMACTL_PROVIDERS_FILE",
  },
  {
    file: "embersynth.yaml",
    name: "defaultEmbersynthConfigPath",
    resolve: defaultEmbersynthConfigPath,
    variable: "LLAMACTL_EMBERSYNTH_CONFIG",
  },
];

describe("paths configBaseDir", () => {
  test("uses DEV_STORAGE when it is set", () => {
    expect(configBaseDir({ DEV_STORAGE: "/srv/dev" })).toBe("/srv/dev");
  });

  test("falls back to ~/.llamactl when DEV_STORAGE is unset", () => {
    expect(configBaseDir({})).toBe(HOME_BASE);
  });

  test("trims surrounding whitespace from DEV_STORAGE", () => {
    expect(configBaseDir({ DEV_STORAGE: "  /srv/dev  " })).toBe("/srv/dev");
  });

  test("a blank or whitespace-only DEV_STORAGE falls back to ~/.llamactl", () => {
    expect(configBaseDir({ DEV_STORAGE: "" })).toBe(HOME_BASE);
    expect(configBaseDir({ DEV_STORAGE: "   " })).toBe(HOME_BASE);
  });

  test("per-file overrides do not move the config root", () => {
    const overrides: NodeJS.ProcessEnv = {
      LLAMACTL_CONFIG: "/elsewhere/config",
      LLAMACTL_EMBERSYNTH_CONFIG: "/elsewhere/embersynth.yaml",
      LLAMACTL_PROVIDERS_FILE: "/elsewhere/sirius-providers.yaml",
    };
    expect(configBaseDir(overrides)).toBe(HOME_BASE);
    expect(configBaseDir({ ...overrides, DEV_STORAGE: "/d" })).toBe("/d");
  });
});

for (const row of FILE_ROWS) {
  describe(`paths ${row.name}`, () => {
    test("defaults to ~/.llamactl/<file> when nothing is set", () => {
      expect(row.resolve({})).toBe(join(HOME_BASE, row.file));
    });

    test("derives <file> from DEV_STORAGE when there is no override", () => {
      expect(row.resolve({ DEV_STORAGE: "/d" })).toBe(join("/d", row.file));
    });

    test("the trimmed override wins over DEV_STORAGE", () => {
      expect(row.resolve({ [row.variable]: " /x/override.yaml ", DEV_STORAGE: "/d" })).toBe(
        "/x/override.yaml",
      );
    });

    test("a blank or whitespace-only override falls through to DEV_STORAGE", () => {
      expect(row.resolve({ [row.variable]: "", DEV_STORAGE: "/d" })).toBe(join("/d", row.file));
      expect(row.resolve({ [row.variable]: "  ", DEV_STORAGE: "/d" })).toBe(join("/d", row.file));
    });

    test("its override does not change the other two paths", () => {
      const others = FILE_ROWS.filter((other) => other.variable !== row.variable);
      const env: NodeJS.ProcessEnv = { [row.variable]: "/x/only", DEV_STORAGE: "/d" };
      expect(others.map((other) => other.resolve(env))).toEqual(
        others.map((other) => join("/d", other.file)),
      );
    });
  });
}
