import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import * as lib from "../src/index.ts";
import { catchRejection, sleep } from "./helpers.ts";

function makeClient(opts?: { framing?: "newline" | "content-length"; logger?: lib.ExecLogger }): {
  client: lib.StdioAcpClient;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const client = new lib.StdioAcpClient({
    stdin,
    stdout,
    ...(opts?.framing !== undefined ? { framing: opts.framing } : {}),
    ...(opts?.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return { client, stdin, stdout };
}

function nextWireLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      stream.off("data", onData);
      resolve(JSON.parse(buf.slice(0, idx)) as Record<string, unknown>);
    };
    stream.on("data", onData);
  });
}

describe("[B8] closed transport", () => {
  test("[B8] request() on a closed transport rejects AcpTransportClosedError within 50ms", async () => {
    const { client, stdout } = makeClient();
    stdout.destroy();
    await sleep(20);

    const t0 = Date.now();
    const outcome = await Promise.race([
      client.request("session/new", { cwd: "/tmp" }).then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      sleep(50).then(() => ({ kind: "timed-out" as const })),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.err).toBeInstanceOf(lib.AcpTransportClosedError);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("[B8] an in-flight request still rejects when the transport closes", async () => {
    const { client, stdout } = makeClient();
    const pending = client.request("initialize", { protocolVersion: 1 });
    stdout.destroy();

    const err = await catchRejection(pending);
    expect(err).toBeInstanceOf(lib.AcpTransportClosedError);
  });

  test("[B8] notify() after close throws AcpTransportClosedError synchronously", () => {
    const { client, stdout } = makeClient();
    stdout.destroy();
    expect(() => {
      client.notify("session/cancel", {});
    }).toThrow(lib.AcpTransportClosedError);
  });
});

describe("[B8] framing limits", () => {
  test("[B8] an oversized Content-Length frame breaks framing and rejects pending requests", async () => {
    const { client, stdin, stdout } = makeClient({ framing: "content-length" });
    const pending = client.request("initialize", { protocolVersion: 1 });
    stdin.on("data", () => {
      // drain outbound writes
    });

    stdout.write(`Content-Length: ${String(32 * 1024 * 1024)}\r\n\r\n`);

    const err = await catchRejection(pending);
    expect(err).toBeInstanceOf(Error);
    expect(client.isTransportOpen()).toBe(false);
  });

  test("[B8] a frame header without Content-Length breaks framing and rejects pending requests", async () => {
    const { client, stdin, stdout } = makeClient({ framing: "content-length" });
    const pending = client.request("initialize", { protocolVersion: 1 });
    stdin.on("data", () => {
      // drain outbound writes
    });

    stdout.write("Content-Type: application/json\r\n\r\n");

    const err = await catchRejection(pending);
    expect(err).toBeInstanceOf(lib.AcpTransportClosedError);
    expect(client.isTransportOpen()).toBe(false);
  });
});

describe("[B8] stream and handler faults", () => {
  // Content-length framing attaches no readline partner: a once()-registered
  // error listener would leave the second emit without a handler and throw.
  test("[B8] a second stdout error after the transport closes does not throw (content-length)", async () => {
    const { client, stdout } = makeClient({ framing: "content-length" });
    const pending = client.request("initialize", {}).catch((err: unknown) => err);
    stdout.emit("error", new Error("first stream fault"));
    await pending;
    expect(client.isTransportOpen()).toBe(false);
    expect(() => {
      stdout.emit("error", new Error("second stream fault"));
    }).not.toThrow();
  });

  test("[B8] a second stdin error after the transport closes does not throw", async () => {
    const { client, stdin } = makeClient({ framing: "content-length" });
    const pending = client.request("initialize", {}).catch((err: unknown) => err);
    stdin.emit("error", new Error("first stdin fault"));
    await pending;
    expect(client.isTransportOpen()).toBe(false);
    expect(() => {
      stdin.emit("error", new Error("second stdin fault"));
    }).not.toThrow();
  });

  test("[B8] a synchronous write failure rejects the request and leaves no orphan", async () => {
    const { client, stdin, stdout } = makeClient();
    stdin.write = (): boolean => {
      throw new Error("write exploded");
    };
    const err = await catchRejection(client.request("initialize", {}));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("write exploded");
    expect(client.pendingRequestCount).toBe(0);
    expect(client.isTransportOpen()).toBe(true);
    stdout.destroy();
    await sleep(10);
    const late = await catchRejection(client.request("session/new", {}));
    expect(late).toBeInstanceOf(lib.AcpTransportClosedError);
    expect(client.pendingRequestCount).toBe(0);
  });

  test("[B8] a throwing notification handler is logged and the transport stays open", async () => {
    const warns: string[] = [];
    const { client, stdout } = makeClient({
      logger: {
        warn: (msg) => {
          warns.push(msg);
        },
      },
    });
    client.on("session/update", () => {
      throw new Error("handler exploded");
    });
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} })}\n`);
    await sleep(30);
    expect(client.isTransportOpen()).toBe(true);
    expect(warns.some((w) => w.includes("notification handler threw"))).toBe(true);
  });

  test("[B8] a throwing request handler answers a generic error frame and logs no wire payload", async () => {
    const warnFields: string[] = [];
    const { client, stdin, stdout } = makeClient({
      logger: {
        warn: (_msg, fields) => {
          warnFields.push(JSON.stringify(fields ?? {}));
        },
      },
    });
    client.onRequest("danger/method", () => {
      throw new Error("secret-payload-XYZ");
    });
    const responsePromise = nextWireLine(stdin);
    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 42, method: "danger/method", params: {} })}\n`,
    );
    const response = await responsePromise;
    const error = response["error"] as { code?: number; message?: string } | undefined;
    expect(error?.code).toBe(-32000);
    expect(JSON.stringify(response)).not.toContain("secret-payload-XYZ");
    expect(warnFields.length).toBeGreaterThanOrEqual(1);
    expect(warnFields.join("\n")).not.toContain("secret-payload-XYZ");
    expect(client.isTransportOpen()).toBe(true);
  });

  test("[B8] a sentinel inside invalid JSON reaches no logger field in either framing", async () => {
    const sentinel = "SENTINEL-payload-9f2c";
    for (const framing of ["newline", "content-length"] as const) {
      const seen: string[] = [];
      const { client, stdin, stdout } = makeClient({
        framing,
        logger: {
          warn: (msg, fields) => {
            seen.push(`${msg} ${JSON.stringify(fields ?? {})}`);
          },
          error: (msg, fields) => {
            seen.push(`${msg} ${JSON.stringify(fields ?? {})}`);
          },
        },
      });
      const pending = client.request("initialize", {}).catch((err: unknown) => err);
      stdin.on("data", () => {
        // drain outbound writes
      });
      if (framing === "newline") {
        stdout.write(`{"jsonrpc":"2.0","id":"${sentinel}\n`);
      } else {
        const body = `{"jsonrpc":"2.0","id":"${sentinel}`;
        stdout.write(`Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
      }
      await sleep(30);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.join("\n")).not.toContain(sentinel);
      stdout.destroy();
      await pending;
    }
  });
});
