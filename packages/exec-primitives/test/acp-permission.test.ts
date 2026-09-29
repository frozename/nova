import { describe, expect, test } from "bun:test";

import * as lib from "../src/index.ts";
import { type FakeAcp, requestsTo, sleep, startFakeAcp, stopFakeAcp } from "./helpers.ts";

interface DecideCall {
  toolName: string;
  rawInput: unknown;
  sessionId: string;
}

async function bootedFake(
  decide?: (req: DecideCall) => Promise<"approve" | "reject"> | "approve" | "reject",
  signal?: AbortSignal,
): Promise<{
  fake: FakeAcp;
  outcomes: lib.PermissionResult[];
  decideCalls: DecideCall[];
  promptDone: Promise<unknown>;
}> {
  const fake = await startFakeAcp("perm", { FAKE_ACP_ASK_PERMISSION: "1" });
  const outcomes: lib.PermissionResult[] = [];
  const decideCalls: DecideCall[] = [];
  const context = new lib.StdioAcpPermissionContext();
  const session = await lib.initializeAcpSession({
    client: fake.client,
    clientInfo: { name: "perm-probe", version: "0.0.0" },
    clientCapabilities: {},
    protocolVersion: 1,
    cwd: fake.dir,
    bootDeadlineMs: 5_000,
    signal: new AbortController().signal,
    selectAuthMethod: () => null,
  });
  context.activate(session.sessionId);

  const host: lib.PermissionHost = {
    signal: signal ?? new AbortController().signal,
    dispatchId: "dispatch-perm-1",
    ...(decide === undefined
      ? {}
      : {
          decide: async (req: DecideCall): Promise<"approve" | "reject"> => {
            decideCalls.push(req);
            return await decide(req);
          },
        }),
  };
  fake.client.onRequest("session/request_permission", async (params) => {
    const outcome = await lib.handleStdioAcpPermissionRequest(host, context, params);
    outcomes.push(outcome);
    return outcome;
  });
  const promptDone = fake.client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "go" }],
  });
  return { fake, outcomes, decideCalls, promptDone };
}

describe("[PERM] permission requests over a real ACP transport", () => {
  test("[PERM] a host without decide cancels the request (deny by default)", async () => {
    const { fake, outcomes, promptDone } = await bootedFake();
    try {
      await promptDone;
      expect(outcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
      const responses = requestsTo(fake.logPath, "session/request_permission");
      expect(responses).toHaveLength(1);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] a throwing decide selects reject_once", async () => {
    const { fake, outcomes, promptDone } = await bootedFake(() => {
      throw new Error("decider exploded");
    });
    try {
      await promptDone;
      expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "reject_once" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] a throwing decide logs only the error class, never the message", async () => {
    const context = new lib.StdioAcpPermissionContext();
    context.activate("sess");
    const logged: string[] = [];
    const host: lib.PermissionHost = {
      signal: new AbortController().signal,
      dispatchId: "dispatch-perm-errclass",
      decide: () => {
        throw new Error("SECRET-decide-7b21");
      },
      logger: {
        warn: (msg, fields) => {
          logged.push(`${msg} ${JSON.stringify(fields ?? {})}`);
        },
        error: (msg, fields) => {
          logged.push(`${msg} ${JSON.stringify(fields ?? {})}`);
        },
      },
    };
    const result = await lib.handleStdioAcpPermissionRequest(host, context, {
      sessionId: "sess",
      toolCall: { toolCallId: "tc-err", name: "terminal/create", rawInput: {} },
      options: [{ kind: "reject_once", optionId: "reject_once" }],
    });
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.join("\n")).not.toContain("SECRET-decide-7b21");
    expect(logged.join("\n")).toContain("errClass");
  });

  test("[PERM] decide receives toolName, rawInput and sessionId from the wire", async () => {
    const { fake, outcomes, decideCalls, promptDone } = await bootedFake(() => "approve");
    try {
      await promptDone;
      expect(decideCalls).toEqual([
        {
          toolName: "fake/tool",
          rawInput: { command: "fake-cmd", note: "from fake-acp" },
          sessionId: "fake-session-1",
        },
      ]);
      expect(outcomes).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] an aborted signal cancels before decide runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fake, outcomes, decideCalls, promptDone } = await bootedFake(
      () => "approve",
      controller.signal,
    );
    try {
      await promptDone;
      expect(decideCalls).toHaveLength(0);
      expect(outcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    } finally {
      await stopFakeAcp(fake);
    }
  });

  test("[PERM] selectConfigOption and selectTrustAllOption are pure exported helpers", () => {
    const options = [
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "allow_once", optionId: "allow_once" },
      { kind: "reject_once", optionId: "reject_once" },
    ];
    expect(lib.selectConfigOption(options, "approve")?.optionId).toBe("allow_once");
    expect(lib.selectConfigOption(options, "reject")?.optionId).toBe("reject_once");
    expect(lib.selectConfigOption(options, "approve")).toEqual(
      lib.selectConfigOption(options, "approve"),
    );
    expect(lib.selectTrustAllOption(options)?.optionId).toBe("switch_bypass");
  });
});

describe("[PERM] permission decision inputs", () => {
  test("[PERM] decide receives toolCall.name, not the agent-controlled title", async () => {
    const context = new lib.StdioAcpPermissionContext();
    context.activate("sess");
    const calls: DecideCall[] = [];
    const host: lib.PermissionHost = {
      signal: new AbortController().signal,
      dispatchId: "dispatch-perm-name",
      decide: (req) => {
        calls.push(req);
        return "approve";
      },
    };
    const result = await lib.handleStdioAcpPermissionRequest(host, context, {
      sessionId: "sess",
      toolCall: {
        toolCallId: "tc-name",
        name: "terminal/create",
        title: "harmless label",
        rawInput: { cmd: "ls" },
      },
      options: [{ kind: "allow_once", optionId: "allow_once" }],
    });
    expect(calls).toEqual([
      { toolName: "terminal/create", rawInput: { cmd: "ls" }, sessionId: "sess" },
    ]);
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  test("[PERM] a class-host decide is invoked with its own this-binding", async () => {
    const context = new lib.StdioAcpPermissionContext();
    context.activate("sess");
    class ClassDecider implements lib.PermissionHost {
      signal = new AbortController().signal;
      dispatchId = "dispatch-perm-class";
      calls = 0;
      decide(_req: lib.PermissionDecideRequest): "approve" {
        this.calls += 1;
        return "approve";
      }
    }
    const host = new ClassDecider();
    const result = await lib.handleStdioAcpPermissionRequest(host, context, {
      sessionId: "sess",
      toolCall: { toolCallId: "tc-class", name: "terminal/create", rawInput: {} },
      options: [{ kind: "allow_once", optionId: "allow_once" }],
    });
    expect(host.calls).toBe(1);
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  test("[PERM] aborting the host signal while decide is pending resolves cancelled", async () => {
    const context = new lib.StdioAcpPermissionContext();
    context.activate("sess");
    const ac = new AbortController();
    let decideCalls = 0;
    const host: lib.PermissionHost = {
      signal: ac.signal,
      dispatchId: "dispatch-perm-abort",
      decide: () => {
        decideCalls += 1;
        return new Promise<"approve" | "reject">(() => {
          // decide never settles — abort must still resolve the wire request
        });
      },
    };
    const pending = lib.handleStdioAcpPermissionRequest(host, context, {
      sessionId: "sess",
      toolCall: { toolCallId: "tc-abort", name: "terminal/create", rawInput: {} },
      options: [{ kind: "allow_once", optionId: "allow_once" }],
    });
    await sleep(20);
    ac.abort();
    const result = await pending;
    expect(decideCalls).toBe(1);
    expect(result).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
