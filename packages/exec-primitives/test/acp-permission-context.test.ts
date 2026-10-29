import { describe, expect, test } from "bun:test";

import * as lib from "../src/index.ts";

/**
 * Pins StdioAcpPermissionContext and the pure option selectors in
 * `src/stdio-acp-permission.ts` by calling them directly: session gating,
 * replay refusal, terminal-status retirement, context merging, the 1024-char
 * id and 64 KiB rawInput caps, the 64-entry context window, stale decisions
 * and the 4096-id overflow fail-closed. In-process only: no transport, fs,
 * timers or network.
 */

const SESSION = "sess-1";
const CANCELLED: lib.PermissionResult = { outcome: { outcome: "cancelled" } };
const SELECTED_ALLOW: lib.PermissionResult = {
  outcome: { optionId: "allow_once", outcome: "selected" },
};
const ALLOW_AND_REJECT = [
  { kind: "allow_once", optionId: "allow_once" },
  { kind: "reject_once", optionId: "reject_once" },
];

type Decision = Omit<lib.ResolvedPermissionContext, "decisionToken">;

interface OptionRow {
  expected: string | undefined;
  options: { kind: string; optionId: unknown }[];
}

interface ConfigRow extends OptionRow {
  decision: "approve" | "reject";
}

interface CountingHost {
  decideCalls: lib.PermissionDecideRequest[];
  host: lib.PermissionHost;
}

interface Cyclic {
  self?: Cyclic;
}

function activeContext(): lib.StdioAcpPermissionContext {
  const context = new lib.StdioAcpPermissionContext();
  context.activate(SESSION);
  return context;
}

function request(
  toolCallId: unknown,
  fields: lib.AcpPermissionToolCallContext = {},
): lib.AcpPermissionRequestContext {
  return { sessionId: SESSION, toolCall: { ...fields, toolCallId } };
}

function fullRequest(toolCallId: string): lib.AcpPermissionRequestContext {
  return request(toolCallId, { name: "fs/read", rawInput: { path: "a.txt" } });
}

function observeCall(
  context: lib.StdioAcpPermissionContext,
  toolCallId: string,
  fields: lib.AcpPermissionToolCallUpdate,
): void {
  context.observe(SESSION, { ...fields, sessionUpdate: "tool_call", toolCallId });
}

function observeUpdate(
  context: lib.StdioAcpPermissionContext,
  toolCallId: string,
  fields: lib.AcpPermissionToolCallUpdate,
): void {
  context.observe(SESSION, { ...fields, sessionUpdate: "tool_call_update", toolCallId });
}

function decisionOf(resolved: lib.ResolvedPermissionContext | null): Decision | null {
  if (resolved === null) {
    return null;
  }
  return {
    rawInput: resolved.rawInput,
    sessionId: resolved.sessionId,
    toolCallId: resolved.toolCallId,
    toolName: resolved.toolName,
  };
}

function resolveOrThrow(
  context: lib.StdioAcpPermissionContext,
  req: lib.AcpPermissionRequestContext,
): lib.ResolvedPermissionContext {
  const resolved = context.resolve(req);
  if (resolved === null) {
    throw new Error("expected resolve() to return a permission context");
  }
  return resolved;
}

function countingHost(
  decide: () => "approve" | "reject",
  signal: AbortSignal = new AbortController().signal,
): CountingHost {
  const decideCalls: lib.PermissionDecideRequest[] = [];
  return {
    decideCalls,
    host: {
      decide: (req: lib.PermissionDecideRequest): "approve" | "reject" => {
        decideCalls.push(req);
        return decide();
      },
      dispatchId: "dispatch-ctx-1",
      signal,
    },
  };
}

describe("StdioAcpPermissionContext.resolve gating", () => {
  test("resolves a request that carries its own name and rawInput", () => {
    const context = activeContext();
    const resolved = context.resolve(fullRequest("tc-1"));
    expect(decisionOf(resolved)).toEqual({
      rawInput: { path: "a.txt" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "fs/read",
    });
    expect(typeof resolved?.decisionToken).toBe("symbol");
  });

  test("returns null before activate(), for another session and after deactivate()", () => {
    const fresh = new lib.StdioAcpPermissionContext();
    expect(fresh.resolve(fullRequest("tc-1"))).toBeNull();

    const context = activeContext();
    expect(context.resolve({ ...fullRequest("tc-1"), sessionId: "sess-other" })).toBeNull();
    expect(context.resolve({ ...fullRequest("tc-1"), sessionId: 1 })).toBeNull();
    expect(context.matchesActiveSession(SESSION)).toBe(true);
    context.deactivate();
    expect(context.matchesActiveSession(SESSION)).toBe(false);
    expect(context.resolve(fullRequest("tc-1"))).toBeNull();
  });

  test("a request refused for another session does not retire its id", () => {
    const context = activeContext();
    expect(context.resolve({ ...fullRequest("tc-1"), sessionId: "sess-other" })).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-1")))?.toolCallId).toBe("tc-1");
  });

  test("returns null for a missing or non-object toolCall and a bad toolCallId", () => {
    const context = activeContext();
    const requests: lib.AcpPermissionRequestContext[] = [
      { sessionId: SESSION },
      { sessionId: SESSION, toolCall: "tc-1" as unknown as lib.AcpPermissionToolCallContext },
      { sessionId: SESSION, toolCall: null as unknown as lib.AcpPermissionToolCallContext },
      request("", { name: "fs/read", rawInput: {} }),
      request("t".repeat(1025), { name: "fs/read", rawInput: {} }),
      request(7, { name: "fs/read", rawInput: {} }),
      request(undefined, { name: "fs/read", rawInput: {} }),
    ];
    expect(requests.map((req) => decisionOf(context.resolve(req)))).toEqual(
      requests.map(() => null),
    );
  });

  test("accepts a toolCallId of exactly 1024 characters", () => {
    const context = activeContext();
    const longId = "t".repeat(1024);
    expect(decisionOf(context.resolve(fullRequest(longId)))?.toolCallId).toBe(longId);
  });
});

describe("StdioAcpPermissionContext replay refusal", () => {
  test("a second resolve of the same toolCallId returns null", () => {
    const context = activeContext();
    expect(decisionOf(context.resolve(fullRequest("tc-1")))?.toolCallId).toBe("tc-1");
    expect(decisionOf(context.resolve(fullRequest("tc-1")))).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-2")))?.toolCallId).toBe("tc-2");
  });

  test("a resolve refused for a missing tool name or rawInput still retires the id", () => {
    const context = activeContext();
    expect(context.resolve(request("tc-1", { rawInput: {} }))).toBeNull();
    expect(context.resolve(request("tc-2", { name: "fs/read" }))).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-1")))).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-2")))).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-3")))?.toolCallId).toBe("tc-3");
  });
});

describe("StdioAcpPermissionContext.observe", () => {
  test("a terminal status on tool_call or tool_call_update retires the id", () => {
    const statuses = ["completed", "failed", "canceled", "cancelled"];
    const kinds = ["tool_call", "tool_call_update"];
    const accepted: string[] = [];
    for (const status of statuses) {
      for (const sessionUpdate of kinds) {
        const context = activeContext();
        observeCall(context, "tc-1", { name: "fs/read", rawInput: {} });
        context.observe(SESSION, { sessionUpdate, status, toolCallId: "tc-1" });
        if (context.resolve(fullRequest("tc-1")) !== null) {
          accepted.push(`${sessionUpdate}:${status}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  test("a non-terminal status keeps the retained context", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "fs/read", rawInput: { path: "a.txt" } });
    observeUpdate(context, "tc-1", { status: "in_progress" });
    expect(decisionOf(context.resolve(request("tc-1")))).toEqual({
      rawInput: { path: "a.txt" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "fs/read",
    });
  });

  test("ignores other sessions, other update kinds and an empty toolCallId", () => {
    const context = activeContext();
    const fields = { name: "fs/read", rawInput: { path: "a.txt" } };
    context.observe("sess-other", { ...fields, sessionUpdate: "tool_call", toolCallId: "tc-1" });
    context.observe(SESSION, {
      ...fields,
      sessionUpdate: "agent_message_chunk",
      toolCallId: "tc-1",
    });
    context.observe(SESSION, { ...fields, sessionUpdate: "tool_call", toolCallId: "" });
    expect(context.resolve(request("tc-1"))).toBeNull();
    context.observe("sess-other", {
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tc-2",
    });
    context.observe(SESSION, { sessionUpdate: "plan", status: "completed", toolCallId: "tc-2" });
    expect(decisionOf(context.resolve(fullRequest("tc-2")))?.toolCallId).toBe("tc-2");
  });

  test("an observe of a retired id does not take a context slot", () => {
    const context = activeContext();
    expect(decisionOf(context.resolve(fullRequest("tc-retired")))?.toolCallId).toBe("tc-retired");
    for (let i = 0; i < 64; i += 1) {
      observeCall(context, `tc-${String(i)}`, { name: `tool-${String(i)}`, rawInput: { i } });
    }
    observeCall(context, "tc-retired", { name: "fs/read", rawInput: {} });
    expect(decisionOf(context.resolve(request("tc-0")))?.toolName).toBe("tool-0");
  });
});

describe("StdioAcpPermissionContext context merging", () => {
  test("resolve falls back to the retained name and rawInput", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "fs/read", rawInput: { path: "a.txt" } });
    expect(decisionOf(context.resolve(request("tc-1")))).toEqual({
      rawInput: { path: "a.txt" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "fs/read",
    });
  });

  test("a tool_call_update merges into the retained context, with input as the rawInput fallback", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { title: "Read a file" });
    observeUpdate(context, "tc-1", { input: { path: "b.txt" } });
    observeUpdate(context, "tc-1", { name: "fs/read" });
    expect(decisionOf(context.resolve(request("tc-1")))).toEqual({
      rawInput: { path: "b.txt" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "fs/read",
    });
  });

  test("rawInput wins over input on the same update", () => {
    const context = activeContext();
    observeCall(context, "tc-1", {
      input: { from: "input" },
      name: "fs/read",
      rawInput: { from: "rawInput" },
    });
    expect(decisionOf(context.resolve(request("tc-1")))?.rawInput).toEqual({ from: "rawInput" });
  });

  test("a new tool_call resets the retained context", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "fs/read", rawInput: { path: "a.txt" } });
    observeCall(context, "tc-1", { rawInput: { path: "c.txt" }, title: "Second call" });
    expect(decisionOf(context.resolve(request("tc-1")))).toEqual({
      rawInput: { path: "c.txt" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "Second call",
    });
  });

  test("toolName is the name, falling back to the title", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { rawInput: {}, title: "Run tests" });
    observeCall(context, "tc-2", { name: "terminal/create", rawInput: {}, title: "Run tests" });
    expect(decisionOf(context.resolve(request("tc-1")))?.toolName).toBe("Run tests");
    expect(decisionOf(context.resolve(request("tc-2")))?.toolName).toBe("terminal/create");
  });

  test("an observed name set to an empty string clears the retained name", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "fs/read", rawInput: {}, title: "Read a file" });
    observeUpdate(context, "tc-1", { name: "" });
    expect(decisionOf(context.resolve(request("tc-1")))?.toolName).toBe("Read a file");
  });

  test("the request's own name, title and rawInput win over the retained ones", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "retained/name", rawInput: { from: "observe" } });
    observeCall(context, "tc-2", { rawInput: {}, title: "Retained title" });
    const own = request("tc-1", { name: "request/name", rawInput: { from: "request" } });
    expect(decisionOf(context.resolve(own))).toEqual({
      rawInput: { from: "request" },
      sessionId: SESSION,
      toolCallId: "tc-1",
      toolName: "request/name",
    });
    const ownTitle = request("tc-2", { title: "Request title" });
    expect(decisionOf(context.resolve(ownTitle))?.toolName).toBe("Request title");
  });

  test("an empty or over-long request field does not fall back to the retained value", () => {
    const context = activeContext();
    observeCall(context, "tc-1", { name: "retained/name", rawInput: {}, title: "Retained title" });
    observeCall(context, "tc-2", { name: "retained/name", rawInput: {}, title: "Retained title" });
    observeCall(context, "tc-3", { name: "retained/name", rawInput: {} });
    observeCall(context, "tc-4", { name: "retained/name", rawInput: { from: "observe" } });
    const emptyName = request("tc-1", { name: "" });
    const longName = request("tc-2", { name: "n".repeat(1025) });
    expect(decisionOf(context.resolve(emptyName))?.toolName).toBe("Retained title");
    expect(decisionOf(context.resolve(longName))?.toolName).toBe("Retained title");
    expect(context.resolve(request("tc-3", { name: "" }))).toBeNull();
    expect(context.resolve(request("tc-4", { rawInput: undefined }))).toBeNull();
  });
});

describe("StdioAcpPermissionContext rawInput retention", () => {
  test("a retained rawInput is a JSON deep copy taken at observe time", () => {
    const context = activeContext();
    const observed = { nested: { list: [1, 2] } };
    observeCall(context, "tc-1", { name: "fs/read", rawInput: observed });
    observed.nested.list.push(3);
    const resolved = context.resolve(request("tc-1"));
    expect(resolved?.rawInput).toEqual({ nested: { list: [1, 2] } });
    expect(resolved?.rawInput).not.toBe(observed);
    const sent = { path: "a.txt" };
    const direct = context.resolve(request("tc-2", { name: "fs/read", rawInput: sent }));
    expect(direct?.rawInput).toEqual({ path: "a.txt" });
    expect(direct?.rawInput).not.toBe(sent);
  });

  test("rawInput JSON of up to 64 KiB is kept and one byte more is not", () => {
    const context = activeContext();
    const fits = "x".repeat(64 * 1024 - 2);
    const tooBig = "x".repeat(64 * 1024 - 1);
    const kept = context.resolve(request("tc-1", { name: "fs/read", rawInput: fits }));
    expect(kept?.toolCallId).toBe("tc-1");
    expect(kept?.rawInput === fits).toBe(true);
    expect(context.resolve(request("tc-2", { name: "fs/read", rawInput: tooBig }))).toBeNull();
    observeCall(context, "tc-3", { name: "fs/read", rawInput: tooBig });
    expect(context.resolve(request("tc-3"))).toBeNull();
    observeCall(context, "tc-4", { name: "fs/read", rawInput: { ok: true } });
    observeUpdate(context, "tc-4", { rawInput: tooBig });
    expect(context.resolve(request("tc-4"))).toBeNull();
  });

  test("a rawInput that JSON cannot serialize is not retained", () => {
    const context = activeContext();
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const bigint = { count: BigInt(1) };
    expect(context.resolve(request("tc-1", { name: "fs/read", rawInput: bigint }))).toBeNull();
    expect(context.resolve(request("tc-2", { name: "fs/read", rawInput: cyclic }))).toBeNull();
    expect(context.resolve(request("tc-3", { name: "fs/read", rawInput: undefined }))).toBeNull();
  });
});

describe("StdioAcpPermissionContext bounded context window", () => {
  test("only the 64 most recent tool-call contexts are kept", () => {
    const context = activeContext();
    for (let i = 0; i <= 64; i += 1) {
      observeCall(context, `tc-${String(i)}`, { name: `tool-${String(i)}`, rawInput: { i } });
    }
    expect(decisionOf(context.resolve(request("tc-0")))).toBeNull();
    expect(decisionOf(context.resolve(request("tc-1")))?.toolName).toBe("tool-1");
    expect(decisionOf(context.resolve(request("tc-64")))?.toolName).toBe("tool-64");
  });

  test("re-observing an id makes it the most recent", () => {
    const context = activeContext();
    for (let i = 0; i < 64; i += 1) {
      observeCall(context, `tc-${String(i)}`, { name: `tool-${String(i)}`, rawInput: { i } });
    }
    observeUpdate(context, "tc-0", { status: "in_progress" });
    observeCall(context, "tc-64", { name: "tool-64", rawInput: { i: 64 } });
    expect(decisionOf(context.resolve(request("tc-0")))?.toolName).toBe("tool-0");
    expect(decisionOf(context.resolve(request("tc-1")))).toBeNull();
  });
});

describe("StdioAcpPermissionContext.finishDecision", () => {
  test("returns true once for the current decision", () => {
    const context = activeContext();
    const resolved = resolveOrThrow(context, fullRequest("tc-1"));
    expect(context.finishDecision(resolved)).toBe(true);
    expect(context.finishDecision(resolved)).toBe(false);
  });

  test("a decision is stale after activate(), even for the same session", () => {
    const context = activeContext();
    const first = resolveOrThrow(context, fullRequest("tc-1"));
    context.activate("sess-2");
    expect(context.finishDecision(first)).toBe(false);
    context.activate(SESSION);
    const second = resolveOrThrow(context, fullRequest("tc-1"));
    context.activate(SESSION);
    expect(context.finishDecision(second)).toBe(false);
  });

  test("a terminal observe drops the pending decision", () => {
    const context = activeContext();
    const resolved = resolveOrThrow(context, fullRequest("tc-1"));
    observeUpdate(context, "tc-1", { status: "completed" });
    expect(context.finishDecision(resolved)).toBe(false);
  });

  test("a context carrying another token is not current", () => {
    const context = activeContext();
    const resolved = resolveOrThrow(context, fullRequest("tc-1"));
    expect(context.finishDecision({ ...resolved, decisionToken: Symbol("tc-1") })).toBe(false);
  });
});

describe("StdioAcpPermissionContext retirement overflow", () => {
  test("the retirement after 4096 retired ids fails closed until activate()", () => {
    const context = activeContext();
    const first = resolveOrThrow(context, fullRequest("tc-0"));
    let resolvedCount = 1;
    for (let i = 1; i < 4096; i += 1) {
      if (context.resolve(fullRequest(`tc-${String(i)}`)) !== null) {
        resolvedCount += 1;
      }
    }
    expect(resolvedCount).toBe(4096);
    expect(decisionOf(context.resolve(fullRequest("tc-4096")))).toBeNull();
    expect(decisionOf(context.resolve(fullRequest("tc-fresh")))).toBeNull();
    expect(context.finishDecision(first)).toBe(false);
    observeCall(context, "tc-observed", { name: "fs/read", rawInput: {} });
    expect(decisionOf(context.resolve(request("tc-observed")))).toBeNull();
    context.activate(SESSION);
    expect(decisionOf(context.resolve(fullRequest("tc-0")))?.toolCallId).toBe("tc-0");
  });
});

describe("selectTrustAllOption and selectConfigOption", () => {
  test("selectTrustAllOption prefers an exact bypass, a plain allow_always, any allow_always, allow_once, then the first option", () => {
    const rows: OptionRow[] = [
      {
        expected: "bypass",
        options: [
          { kind: "allow_always", optionId: "always" },
          { kind: "allow_always", optionId: "bypass" },
        ],
      },
      { expected: "Switch_Bypass", options: [{ kind: "allow_always", optionId: "Switch_Bypass" }] },
      {
        expected: "always",
        options: [
          { kind: "allow_always", optionId: "bypass_all" },
          { kind: "allow_always", optionId: "always" },
        ],
      },
      {
        expected: "bypass_all",
        options: [
          { kind: "allow_once", optionId: "once" },
          { kind: "allow_always", optionId: "bypass_all" },
        ],
      },
      {
        expected: "once",
        options: [
          { kind: "reject_once", optionId: "reject" },
          { kind: "allow_once", optionId: "once" },
        ],
      },
      {
        expected: "reject",
        options: [
          { kind: "reject_once", optionId: "reject" },
          { kind: "reject_always", optionId: "never" },
        ],
      },
      { expected: undefined, options: [] },
    ];
    expect(rows.map((row) => lib.selectTrustAllOption(row.options)?.optionId)).toEqual(
      rows.map((row) => row.expected),
    );
  });

  test("selectConfigOption approves only a non-bypass allow_once and rejects only reject_once", () => {
    const rows: ConfigRow[] = [
      {
        decision: "approve",
        expected: "allow_once",
        options: [
          { kind: "allow_once", optionId: "bypass_once" },
          { kind: "allow_once", optionId: "allow_once" },
        ],
      },
      {
        decision: "approve",
        expected: undefined,
        options: [{ kind: "allow_once", optionId: "ByPass" }],
      },
      { decision: "approve", expected: undefined, options: [{ kind: "allow_once", optionId: 7 }] },
      {
        decision: "approve",
        expected: undefined,
        options: [{ kind: "allow_always", optionId: "allow_always" }],
      },
      {
        decision: "reject",
        expected: "reject_once",
        options: [
          { kind: "reject_always", optionId: "reject_always" },
          { kind: "reject_once", optionId: "reject_once" },
        ],
      },
      { decision: "reject", expected: undefined, options: [{ kind: "reject_once", optionId: 1 }] },
      {
        decision: "reject",
        expected: undefined,
        options: [{ kind: "allow_once", optionId: "allow_once" }],
      },
    ];
    expect(rows.map((row) => lib.selectConfigOption(row.options, row.decision)?.optionId)).toEqual(
      rows.map((row) => row.expected),
    );
  });
});

describe("handleStdioAcpPermissionRequest with an in-memory context", () => {
  test("a non-object wire request cancels without calling decide", async () => {
    const context = activeContext();
    const { decideCalls, host } = countingHost(() => "approve");
    const wires: unknown[] = [null, "request", 5, [], undefined];
    const results: lib.PermissionResult[] = [];
    for (const wire of wires) {
      results.push(await lib.handleStdioAcpPermissionRequest(host, context, wire));
    }
    expect(results).toEqual(wires.map(() => CANCELLED));
    expect(decideCalls).toHaveLength(0);
  });

  test("an aborted signal, another session or a missing decide cancels and leaves the id usable", async () => {
    const context = activeContext();
    const aborted = new AbortController();
    aborted.abort();
    const abortedHost = countingHost(() => "approve", aborted.signal);
    const live = countingHost(() => "approve");
    const noDecide: lib.PermissionHost = {
      dispatchId: "dispatch-ctx-none",
      signal: new AbortController().signal,
    };
    const wire = { ...fullRequest("tc-1"), options: ALLOW_AND_REJECT };
    const otherSession = { ...wire, sessionId: "sess-other" };
    expect(await lib.handleStdioAcpPermissionRequest(abortedHost.host, context, wire)).toEqual(
      CANCELLED,
    );
    expect(await lib.handleStdioAcpPermissionRequest(live.host, context, otherSession)).toEqual(
      CANCELLED,
    );
    expect(await lib.handleStdioAcpPermissionRequest(noDecide, context, wire)).toEqual(CANCELLED);
    expect(abortedHost.decideCalls).toHaveLength(0);
    expect(live.decideCalls).toHaveLength(0);
    expect(await lib.handleStdioAcpPermissionRequest(live.host, context, wire)).toEqual(
      SELECTED_ALLOW,
    );
    expect(live.decideCalls).toEqual([
      { rawInput: { path: "a.txt" }, sessionId: SESSION, toolName: "fs/read" },
    ]);
  });

  test("a replayed wire request is cancelled without a second decide", async () => {
    const context = activeContext();
    const { decideCalls, host } = countingHost(() => "approve");
    const wire = { ...fullRequest("tc-1"), options: ALLOW_AND_REJECT };
    expect(await lib.handleStdioAcpPermissionRequest(host, context, wire)).toEqual(SELECTED_ALLOW);
    expect(await lib.handleStdioAcpPermissionRequest(host, context, wire)).toEqual(CANCELLED);
    expect(decideCalls).toHaveLength(1);
  });

  test("approve without an allow_once option cancels, and reject selects reject_once", async () => {
    const context = activeContext();
    const approve = countingHost(() => "approve");
    const reject = countingHost(() => "reject");
    const options = [
      { kind: "allow_always", optionId: "allow_always" },
      { kind: "reject_once", optionId: "reject_once" },
    ];
    const first = { ...fullRequest("tc-1"), options };
    const second = { ...fullRequest("tc-2"), options };
    expect(await lib.handleStdioAcpPermissionRequest(approve.host, context, first)).toEqual(
      CANCELLED,
    );
    expect(await lib.handleStdioAcpPermissionRequest(reject.host, context, second)).toEqual({
      outcome: { optionId: "reject_once", outcome: "selected" },
    });
    expect(approve.decideCalls).toHaveLength(1);
    expect(reject.decideCalls).toHaveLength(1);
  });

  test("a decision made stale by activate() during decide cancels", async () => {
    const context = activeContext();
    const { decideCalls, host } = countingHost(() => {
      context.activate(SESSION);
      return "approve";
    });
    const wire = { ...fullRequest("tc-1"), options: ALLOW_AND_REJECT };
    expect(await lib.handleStdioAcpPermissionRequest(host, context, wire)).toEqual(CANCELLED);
    expect(decideCalls).toHaveLength(1);
  });
});
