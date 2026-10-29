import { describe, expect, spyOn, test } from "bun:test";

import * as lib from "../src/index.ts";
import {
  catchRejection,
  type FakeAcp,
  readWireLog,
  requestsTo,
  startFakeAcp,
  stopFakeAcp,
} from "./helpers.ts";

const CLIENT_INFO = { name: "probe-client", version: "9.9.9", build: { sha: "abc", dirty: true } };

type BootstrapOpts = Parameters<typeof lib.initializeAcpSession>[0];

function baseOpts(fake: FakeAcp): BootstrapOpts {
  return {
    client: fake.client,
    clientInfo: CLIENT_INFO,
    clientCapabilities: { fs: { readTextFile: false } },
    protocolVersion: 1,
    cwd: fake.dir,
    bootDeadlineMs: 5_000,
    signal: new AbortController().signal,
    selectAuthMethod: () => null,
  };
}

function withoutField(opts: BootstrapOpts, field: keyof BootstrapOpts): BootstrapOpts {
  const entries = Object.entries(opts).filter(([key]) => key !== field);
  return Object.fromEntries(entries) as BootstrapOpts;
}

function stubOpts(client: lib.AcpSessionClient): BootstrapOpts {
  return {
    client,
    clientInfo: CLIENT_INFO,
    clientCapabilities: {},
    protocolVersion: 1,
    cwd: "/tmp/b6-stub",
    bootDeadlineMs: 5_000,
    signal: new AbortController().signal,
    selectAuthMethod: () => "env",
  };
}

// A request that never answers, so a request sent by mistake cannot reject later.
function neverSettle(): void {
  // Intentionally never resolves or rejects.
}

describe("[B6] session bootstrap", () => {
  test("[B6] initialize params carry the host clientInfo verbatim on the wire", async () => {
    const fake = await startFakeAcp("b6-init");
    try {
      const session = await lib.initializeAcpSession(baseOpts(fake));
      expect(session.sessionId).toBe("fake-session-1");
      expect(session.authMethods).toEqual([{ id: "env", type: "env_var" }]);
      expect(session.agentCapabilities).toEqual({ loadSession: false, fake: true });

      const inits = requestsTo(fake.logPath, "initialize");
      expect(inits).toHaveLength(1);
      expect(inits[0]?.params?.["clientInfo"]).toEqual(CLIENT_INFO);
      const news = requestsTo(fake.logPath, "session/new");
      expect(news).toHaveLength(1);
      expect(news[0]?.params?.["cwd"]).toBe(fake.dir);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] a missing clientInfo throws HostInputError before any byte is written", async () => {
    const fake = await startFakeAcp("b6-noclientinfo");
    try {
      const err = await catchRejection(
        lib.initializeAcpSession(withoutField(baseOpts(fake), "clientInfo")),
      );
      expect(err).toBeInstanceOf(lib.HostInputError);
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(0);

      const session = await lib.initializeAcpSession(baseOpts(fake));
      expect(session.sessionId).toBe("fake-session-1");
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(1);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] a missing bootDeadlineMs throws HostInputError before any write", async () => {
    const fake = await startFakeAcp("b6-nodeadline");
    try {
      const err = await catchRejection(
        lib.initializeAcpSession(withoutField(baseOpts(fake), "bootDeadlineMs")),
      );
      expect(err).toBeInstanceOf(lib.HostInputError);
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(0);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] missing protocolVersion, clientCapabilities or selectAuthMethod throw HostInputError before any write", async () => {
    const fake = await startFakeAcp("b6-required");
    try {
      for (const field of ["protocolVersion", "clientCapabilities", "selectAuthMethod"] as const) {
        const err = await catchRejection(
          lib.initializeAcpSession(withoutField(baseOpts(fake), field)),
        );
        expect(err).toBeInstanceOf(lib.HostInputError);
      }
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(0);

      const session = await lib.initializeAcpSession(baseOpts(fake));
      expect(session.sessionId).toBe("fake-session-1");
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(1);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] session/new -32000 runs the selector, authenticates, and issues a single new-session retry", async () => {
    const fake = await startFakeAcp("b6-auth", { FAKE_ACP_REQUIRE_AUTH: "1" });
    try {
      const seen: unknown[] = [];
      const session = await lib.initializeAcpSession({
        ...baseOpts(fake),
        selectAuthMethod: (authMethods) => {
          seen.push(authMethods);
          return "env";
        },
      });
      expect(session.sessionId).toBe("fake-session-1");
      expect(seen).toEqual([[{ id: "env", type: "env_var" }]]);

      const log = readWireLog(fake.logPath);
      const methods = log.filter((l) => l.method !== undefined).map((l) => l.method);
      expect(methods).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] a null selector result rejects the bootstrap", async () => {
    const fake = await startFakeAcp("b6-nullsel", { FAKE_ACP_REQUIRE_AUTH: "1" });
    try {
      const err = await catchRejection(
        lib.initializeAcpSession({
          ...baseOpts(fake),
          selectAuthMethod: () => null,
        }),
      );
      expect(err).toBeInstanceOf(Error);
      const log = readWireLog(fake.logPath);
      const methods = log.filter((l) => l.method !== undefined).map((l) => l.method);
      expect(methods).toEqual(["initialize", "session/new"]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] a passed boot deadline rejects the bootstrap", async () => {
    const fake = await startFakeAcp("b6-deadline", { FAKE_ACP_DELAY_MS: "300" });
    try {
      const err = await catchRejection(
        lib.initializeAcpSession({ ...baseOpts(fake), bootDeadlineMs: 50 }),
      );
      expect((err as Error).message).toMatch(/deadline/i);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] an already-aborted signal rejects before initialize is written", async () => {
    const fake = await startFakeAcp("b6-preabort");
    try {
      const controller = new AbortController();
      controller.abort();
      const err = await catchRejection(
        lib.initializeAcpSession({ ...baseOpts(fake), signal: controller.signal }),
      );
      expect((err as Error).message).toBe("acp-session: bootstrap aborted");

      const session = await lib.initializeAcpSession(baseOpts(fake));
      expect(session.sessionId).toBe("fake-session-1");
      expect(requestsTo(fake.logPath, "initialize")).toHaveLength(1);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[B6] a deadline that passes during initialize rejects without sending session/new", async () => {
    const startedAt = Date.now();
    let offsetMs = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation((): number => startedAt + offsetMs);
    const calls: string[] = [];
    const client: lib.AcpSessionClient = {
      request: (method: string): Promise<unknown> => {
        calls.push(method);
        if (method === "initialize") {
          return Promise.resolve().then((): unknown => {
            offsetMs = 10_000;
            return { authMethods: [] };
          });
        }
        return new Promise<unknown>(neverSettle);
      },
    };
    try {
      const err = await catchRejection(lib.initializeAcpSession(stubOpts(client)));
      expect({ calls, message: (err as Error).message }).toEqual({
        calls: ["initialize"],
        message: "acp-session: boot deadline exceeded before session/new",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("[B6] a deadline that passes during session/new rejects without sending authenticate", async () => {
    const startedAt = Date.now();
    let offsetMs = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation((): number => startedAt + offsetMs);
    const calls: string[] = [];
    const client: lib.AcpSessionClient = {
      request: (method: string): Promise<unknown> => {
        calls.push(method);
        if (method === "initialize") {
          return Promise.resolve({ authMethods: [{ id: "env", type: "env_var" }] });
        }
        if (method === "session/new") {
          return Promise.resolve().then((): never => {
            offsetMs = 10_000;
            throw new lib.AcpResponseError("authentication required", -32000);
          });
        }
        return new Promise<unknown>(neverSettle);
      },
    };
    try {
      const err = await catchRejection(lib.initializeAcpSession(stubOpts(client)));
      expect({ calls, message: (err as Error).message }).toEqual({
        calls: ["initialize", "session/new"],
        message: "acp-session: boot deadline exceeded before authenticate",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
