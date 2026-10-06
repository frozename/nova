import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG_PATH = process.env["FAKE_ACP_LOG"];
const ECHO_ENV = process.env["FAKE_ACP_ECHO_ENV"] === "1";
const REQUIRE_AUTH = process.env["FAKE_ACP_REQUIRE_AUTH"] === "1";
const ASK_PERMISSION = process.env["FAKE_ACP_ASK_PERMISSION"] === "1";
const DELAY_MS = Number(process.env["FAKE_ACP_DELAY_MS"] ?? "0") || 0;

let authenticated = false;
let nextServerRequestId = 900;
const pendingServerRequests = new Map<number, () => void>();

function log(line: string): void {
  if (!LOG_PATH) return;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The test harness supplies this wire log path inside its isolated temporary directory.
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // best-effort wire log
  }
}

interface InboundMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function send(message: Record<string, unknown>): void {
  const line = JSON.stringify(message);
  log(line);
  process.stdout.write(`${line}\n`);
}

function respond(id: number | string | null | undefined, result: unknown): void {
  const message = { jsonrpc: "2.0", id: id ?? null, result };
  if (DELAY_MS > 0) {
    setTimeout(() => {
      send(message);
    }, DELAY_MS);
    return;
  }
  send(message);
}

function respondError(id: number | string | null | undefined, code: number, text: string): void {
  const message = { jsonrpc: "2.0", id: id ?? null, error: { code, message: text } };
  if (DELAY_MS > 0) {
    setTimeout(() => {
      send(message);
    }, DELAY_MS);
    return;
  }
  send(message);
}

function finishPrompt(id: number | string | null | undefined, sessionId: string): void {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fake reply" },
      },
    },
  });
  respond(id, { stopReason: "end_turn" });
}

function askPermissionThenFinish(id: number | string | null | undefined, sessionId: string): void {
  const requestId = nextServerRequestId++;
  send({
    jsonrpc: "2.0",
    id: requestId,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "fake/tool",
        rawInput: { command: "fake-cmd", note: "from fake-acp" },
      },
      options: [
        { kind: "allow_always", optionId: "allow_always" },
        { kind: "allow_once", optionId: "allow_once" },
        { kind: "reject_once", optionId: "reject_once" },
      ],
    },
  });
  pendingServerRequests.set(requestId, () => {
    finishPrompt(id, sessionId);
  });
}

function handleRequest(message: InboundMessage): void {
  const params = message.params ?? {};
  const method = message.method ?? "";
  switch (method) {
    case "initialize": {
      const meta: Record<string, unknown> = {
        echo: {
          clientInfo: params["clientInfo"] ?? null,
          clientCapabilities: params["clientCapabilities"] ?? null,
          protocolVersion: params["protocolVersion"] ?? null,
        },
      };
      if (ECHO_ENV) meta["envKeys"] = Object.keys(process.env).sort();
      respond(message.id, {
        protocolVersion:
          typeof params["protocolVersion"] === "number" ? params["protocolVersion"] : 1,
        agentCapabilities: { loadSession: false, fake: true },
        authMethods: [{ id: "env", type: "env_var" }],
        _meta: meta,
      });
      return;
    }
    case "session/new": {
      if (REQUIRE_AUTH && !authenticated) {
        respondError(message.id, -32000, "authentication required");
        return;
      }
      respond(message.id, { sessionId: "fake-session-1" });
      return;
    }
    case "authenticate": {
      authenticated = true;
      respond(message.id, {});
      return;
    }
    case "session/prompt": {
      const sessionId =
        typeof params["sessionId"] === "string" ? params["sessionId"] : "fake-session-1";
      if (ASK_PERMISSION) {
        askPermissionThenFinish(message.id, sessionId);
        return;
      }
      finishPrompt(message.id, sessionId);
      return;
    }
    default:
      respond(message.id, {});
  }
}

function handleInbound(message: InboundMessage): void {
  if (message.id !== undefined && message.id !== null && message.method === undefined) {
    const pending = pendingServerRequests.get(Number(message.id));
    if (pending !== undefined) {
      pendingServerRequests.delete(Number(message.id));
      pending();
    }
    return;
  }
  if (message.method !== undefined && message.id !== undefined && message.id !== null) {
    handleRequest(message);
    return;
  }
  // Notifications and malformed frames are logged but unanswered.
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  log(trimmed);
  let message: InboundMessage;
  try {
    message = JSON.parse(trimmed) as InboundMessage;
  } catch {
    return;
  }
  handleInbound(message);
});

process.stdin.on("end", () => {
  process.exit(0);
});
