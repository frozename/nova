/**
 * Native unified tools — aggregate calls across multiple downstreams
 * into a single facade-level result. Lives outside src/server.ts so
 * the standalone nova.* tools don't bloat the main server builder.
 *
 * Phase-4 (narrowed to option C): ships `nova.models.list` only.
 * `nova.chat` / `nova.embed` are deferred until a concrete consumer
 * exists — see plan `~/.claude/plans/m3-m4-mcp-convergence.md` Phase 4.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { toTextContent } from "@novaproto/mcp-shared";
import { z } from "zod";

import type { Downstream } from "../facade/downstream.js";

type Provenance = "llamactl" | "sirius" | "embersynth";

interface MergedModel {
  id: string;
  provenance: Provenance;
  details: unknown;
  alsoAvailableIn?: string[];
}

interface NormalizedEntry {
  id: string;
  details: unknown;
}

// Hardcoded priority order — first wins on dedupe. Deliberately static
// (no "smart router"); see plan anti-pattern guard.
const PRIORITY: Provenance[] = ["llamactl", "sirius", "embersynth"];

/**
 * Parse the first `text` content block of a `CallToolResult`. Returns
 * `undefined` if the shape is missing or JSON parse fails — caller
 * treats that as a failed downstream.
 */
function parseTextContent(result: CallToolResult): unknown {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

function normalizeLlamactl(payload: unknown): NormalizedEntry[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedEntry[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const rel = typeof rec["rel"] === "string" ? rec["rel"] : undefined;
    const id = typeof rec["id"] === "string" ? rec["id"] : undefined;
    const pickedId = rel ?? id;
    if (!pickedId) continue;
    out.push({ id: pickedId, details: entry });
  }
  return out;
}

function normalizeSirius(payload: unknown): NormalizedEntry[] {
  if (!payload || typeof payload !== "object") return [];
  // sirius.models.list returns the body of GET /v1/models verbatim —
  // an OpenAI-style `{data: [{id, ...}, ...], object: 'list'}` envelope
  // (with a `status` wrapper from `fetchJson` when sirius is reachable).
  const rec = payload as Record<string, unknown>;
  const body = (rec["body"] && typeof rec["body"] === "object" ? rec["body"] : rec) as Record<
    string,
    unknown
  >;
  const data = Array.isArray(body["data"])
    ? body["data"]
    : Array.isArray(rec["data"])
      ? (rec["data"] as unknown[])
      : [];
  const out: NormalizedEntry[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    out.push({ id, details: entry });
  }
  return out;
}

function normalizeEmbersynth(payload: unknown): NormalizedEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as Record<string, unknown>;
  const map = rec["syntheticModels"];
  if (!map || typeof map !== "object") return [];
  const out: NormalizedEntry[] = [];
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    out.push({ id: key, details: { name: key, profile: value } });
  }
  return out;
}

const INPUT_SCHEMA = {
  scope: z
    .enum(["all", "builtin", "custom"])
    .default("all")
    .describe("Catalog scope forwarded to llamactl.catalog.list. Ignored by other downstreams."),
};

interface SourceResult {
  source: Provenance;
  entries: NormalizedEntry[];
}

interface FailureSink {
  failed: string[];
  errors: Record<string, string>;
}

/** Best-effort text of a downstream `isError` result, for surfacing
 *  in the per-source error map. */
function errorTextOf(result: CallToolResult): string {
  const c = result.content;
  if (Array.isArray(c) && c[0]?.type === "text" && typeof c[0].text === "string") {
    return c[0].text;
  }
  return "downstream returned isError";
}

/** Invoke one downstream, normalize its payload, and fold any failure
 *  into `sink`. Never throws — a failed source yields empty entries so
 *  the aggregate is partial, not fatal. */
async function collectSource(
  source: Provenance,
  invoke: () => Promise<CallToolResult>,
  normalize: (payload: unknown) => NormalizedEntry[],
  sink: FailureSink,
): Promise<SourceResult> {
  try {
    const res = await invoke();
    if (res.isError) {
      throw new Error(errorTextOf(res));
    }
    const parsed = parseTextContent(res);
    if (parsed === undefined) {
      throw new Error("could not parse downstream response");
    }
    return { source, entries: normalize(parsed) };
  } catch (err) {
    sink.failed.push(source);
    sink.errors[source] = err instanceof Error ? err.message : String(err);
    return { source, entries: [] };
  }
}

/** Merge per-source entries in stable PRIORITY order. First occurrence
 *  of an id wins; later sources append to `alsoAvailableIn`. */
function mergeByPriority(perSource: Partial<Record<Provenance, NormalizedEntry[]>>): MergedModel[] {
  const winners = new Map<string, MergedModel>();
  for (const source of PRIORITY) {
    const entries = perSource[source];
    if (!entries) continue;
    for (const e of entries) {
      const existing = winners.get(e.id);
      if (!existing) {
        winners.set(e.id, { id: e.id, provenance: source, details: e.details });
        continue;
      }
      existing.alsoAvailableIn = existing.alsoAvailableIn ?? [];
      if (!existing.alsoAvailableIn.includes(source)) {
        existing.alsoAvailableIn.push(source);
      }
    }
  }
  return [...winners.values()];
}

/** The call plan: which downstream tool + normalizer each provenance
 *  uses. `scope` only flows to llamactl. */
function buildCalls(
  byName: Partial<Record<Provenance, Downstream>>,
  scope: string,
  sink: FailureSink,
): Promise<SourceResult>[] {
  const calls: Promise<SourceResult>[] = [];
  const llamactl = byName.llamactl;
  if (llamactl) {
    calls.push(
      collectSource(
        "llamactl",
        () =>
          llamactl.client.callTool({
            name: "llamactl.catalog.list",
            arguments: { scope },
          }) as Promise<CallToolResult>,
        normalizeLlamactl,
        sink,
      ),
    );
  }
  const sirius = byName.sirius;
  if (sirius) {
    calls.push(
      collectSource(
        "sirius",
        () =>
          sirius.client.callTool({
            name: "sirius.models.list",
            arguments: {},
          }) as Promise<CallToolResult>,
        normalizeSirius,
        sink,
      ),
    );
  }
  const embersynth = byName.embersynth;
  if (embersynth) {
    calls.push(
      collectSource(
        "embersynth",
        () =>
          embersynth.client.callTool({
            name: "embersynth.synthetic.list",
            arguments: {},
          }) as Promise<CallToolResult>,
        normalizeEmbersynth,
        sink,
      ),
    );
  }
  return calls;
}

export function registerUnifiedTools(server: McpServer, downstreams: Downstream[]): void {
  server.registerTool(
    "nova.models.list",
    {
      title: "Unified model catalog",
      description:
        "Aggregate the model catalog across every reachable downstream (llamactl + sirius + embersynth) into one merged, dedup'd list. Each entry records provenance (which downstream claimed it first) and, on overlap, `alsoAvailableIn` for the others. Partial failure is acceptable and reported under `partial`.",
      inputSchema: INPUT_SCHEMA,
    },
    async ({ scope }): Promise<CallToolResult> => {
      // Build a by-name index. Absent-from-config downstreams stay
      // `undefined` and are silently skipped — only *configured*
      // downstreams that fail a live call count as "failed".
      const byName: Partial<Record<Provenance, Downstream>> = {};
      for (const d of downstreams) {
        if (d.name === "llamactl" || d.name === "sirius" || d.name === "embersynth") {
          byName[d.name] = d;
        }
      }

      // Fire every configured call in parallel. `collectSource`
      // catches internally, so allSettled rejections shouldn't happen
      // in practice — still use it for defensive symmetry.
      const sink: FailureSink = { failed: [], errors: {} };
      const settled = await Promise.allSettled(buildCalls(byName, scope, sink));
      const perSource: Partial<Record<Provenance, NormalizedEntry[]>> = {};
      for (const s of settled) {
        if (s.status === "fulfilled") {
          perSource[s.value.source] = s.value.entries;
        }
      }

      const models = mergeByPriority(perSource);
      const partial =
        sink.failed.length > 0 ? { failed: sink.failed, errors: sink.errors } : undefined;

      return toTextContent(partial ? { models, partial } : { models });
    },
  );
}
