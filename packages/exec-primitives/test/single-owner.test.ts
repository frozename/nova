import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";

const PACKAGE_DIR = dirname(import.meta.dir);

describe("[B10] single-owner guarantees", () => {
  test("[L6] two imports of the package produce independent pool instances", async () => {
    const entryUrl = join(PACKAGE_DIR, "src", "index.ts");
    const first = (await import(entryUrl)) as typeof lib;
    const second = (await import(`${entryUrl}?second-import`)) as typeof lib;
    const poolA = first.createAcpWarmPool();
    const poolB = second.createAcpWarmPool();
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let killed = false;
      poolA.deposit(
        {
          agent: "k",
          cwd: "/tmp",
          credentialScope: "s",
          specHash: "h",
        },
        {
          client: {},
          handle: {
            stdin,
            stdout,
            kill: () => {
              killed = true;
            },
            exited: new Promise<number | null>(() => {
              // pending forever: a live mock handle
            }),
            getStderrTail: () => "",
            getSpawnError: () => null,
          },
        },
      );
      expect(poolA.diagnostics().live).toBe(1);
      expect(poolB.diagnostics().live).toBe(0);
      poolB.shutdown();
      expect(killed).toBe(false);
      poolA.shutdown();
      expect(killed).toBe(true);
    } finally {
      poolA.shutdown();
      poolB.shutdown();
    }
  });

  test("[B10] the package namespace contains exactly the documented exports", () => {
    const keys = Object.keys(lib).sort();
    const documented = [
      "AcpResponseError",
      "AcpTransportClosedError",
      "HostInputError",
      "StdioAcpClient",
      "StdioAcpPermissionContext",
      "createAcpWarmPool",
      "detectCapacityError",
      "handleStdioAcpPermissionRequest",
      "initializeAcpSession",
      "poolKeyFor",
      "runProcess",
      "selectConfigOption",
      "selectTrustAllOption",
      "startStdioAcpServer",
      "superviseProcess",
    ];
    for (const name of documented) {
      expect(keys).toContain(name);
    }
    const runtimeKeys = keys.filter(
      (k) => typeof (lib as Record<string, unknown>)[k] !== "undefined",
    );
    expect(runtimeKeys).toEqual([...documented].sort());
  });
});
