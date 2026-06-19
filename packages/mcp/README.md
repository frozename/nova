# @novaproto/mcp

[![npm version](https://img.shields.io/npm/v/@novaproto/mcp.svg)](https://www.npmjs.com/package/@novaproto/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](./tsconfig.base.json)
[![runtime](https://img.shields.io/badge/runtime-Node--portable-339933.svg)](https://nodejs.org)

**A unified operator MCP facade — one entry point that rolls up tools across the llamactl-family servers.**

_Serves native `nova.*` tools (ops overview, healthcheck, cost snapshot, operator plan, models list) and 1:1-proxies every tool advertised by each configured downstream (llamactl, sirius-gateway, embersynth)._

## What it is

`nova-mcp` is a single stdio MCP server that an operator points one client at instead of wiring three. It does two things:

- **Native `nova.*` tools** — read-only operator views computed in-process: a config overview, a soft-fail healthcheck across gateways and providers, a usage-cost snapshot, an NL→plan planner, and a merged models catalog.
- **A 1:1 downstream proxy** — at boot it snapshots each configured downstream's tool list and re-advertises every tool verbatim on the facade, so `llamactl.*`, `sirius.*`, and `embersynth.*` tools all answer through the one connection.

It is node-portable: the library and the CLI entry have no `bun:*` or `Bun.*` dependencies and run on plain Node.js (Bun is the dev/CI runtime only).

## Install

```sh
npm install @novaproto/mcp
# or: bun add @novaproto/mcp
```

The `package.json` range is `"@novaproto/mcp": "^0.1.0"`. Live and installable now, scope `@novaproto`, license MIT.

## CLI: the `nova-mcp` binary

The package ships a `nova-mcp` stdio MCP server. A client spawns it as a subprocess and speaks JSON-RPC over stdin/stdout; diagnostics go to stderr.

```sh
nova-mcp
```

Boot sequence (`bin/nova-mcp.ts`): `loadConfig` reads `~/.llamactl/nova-mcp.yaml` (override with `$NOVA_MCP_CONFIG`) → `bootAll` opens an MCP client connection to each configured downstream → `mountProxyTools` snapshots each downstream's `listTools` and re-advertises every tool as a 1:1 proxy → `registerUnifiedTools` mounts `nova.models.list`. Transport is stdio; `SIGINT`/`SIGTERM` close every downstream cleanly before exit.

Missing config is fine — the facade still serves its native `nova.*` tools. A config error is logged to stderr and the facade boots with zero downstreams rather than failing.

### Configuration

`~/.llamactl/nova-mcp.yaml` (or `$NOVA_MCP_CONFIG`). Each downstream is either a `stdio` spec (`command` + `args`) or an `http` spec (`url`). `${VAR}` references are interpolated from the environment before the config is parsed.

```yaml
version: 1
downstreams:
  - name: llamactl
    transport: stdio
    command: llamactl-mcp
    args: []
  - name: sirius
    transport: http
    url: ${SIRIUS_MCP_URL}
  - name: embersynth
    transport: stdio
    command: embersynth-mcp
```

The proxy snapshots downstreams **at boot only** — there is no hot reload. Restart `nova-mcp` to pick up a downstream's new tools. This is deliberate: the facade reports a stable surface across the connection's lifetime. Tool-name collisions are resolved first-wins, with the native `nova.*` names seeded as already-taken.

## Native tools

All five are read-only operator views and every invocation appends an audit record.

| Tool                         | What it does                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`nova.ops.overview`**      | Reads the three operator YAMLs and returns agents + gateways + providers + profiles + synthetic models. Missing files yield empty sections, never an error.                                                                                                                               |
| **`nova.ops.healthcheck`**   | GET-probes each configured gateway and each sirius provider `baseUrl`; each probe fails soft. Input `timeoutMs` (default `1500`, max `30000`).                                                                                                                                            |
| **`nova.ops.cost.snapshot`** | Aggregates usage JSONL over the last `days` (default `7`, max `90`) into per-provider and per-(provider, model) roll-ups; joins pricing YAML when present. Inputs `days`, `dir`, `pricingDir`, `disablePricing`. Never fails on missing pricing — the group's cost is left blank instead. |
| **`nova.operator.plan`**     | Turns an NL `goal` (plus optional `context`) into a `PlanSchema`-validated tool-call plan, allowlist-filtered. The default executor is a stub; bind an LLM to get real plans (see below).                                                                                                 |
| **`nova.models.list`**       | Fans out to `llamactl.catalog.list` + `sirius.models.list` + `embersynth.synthetic.list` in parallel, merges by the fixed priority `["llamactl", "sirius", "embersynth"]`, dedupes by id (recording `alsoAvailableIn`), and reports `partial` when a source is unreachable.               |

## Library API

```ts
import { buildNovaMcpServer } from "@novaproto/mcp";
```

`buildNovaMcpServer(opts?)` returns a configured `McpServer` with the four in-process operator tools mounted (`nova.ops.overview`, `nova.ops.healthcheck`, `nova.ops.cost.snapshot`, `nova.operator.plan`). The fifth native tool, `nova.models.list` (the cross-downstream aggregator), is added separately by `registerUnifiedTools` during `nova-mcp` boot, since it needs the live downstream clients. Options: `name`, `version`, `plannerExecutor`, `plannerAllowlist`, `plannerTools`.

Also exported from the package index:

- **Cost** — `computeCostSnapshot(opts?): CostSnapshot` (with `byProvider` / `byModel` / `totalEstimatedCostUsd`); types `CostGroup`, `CostSnapshot`, `CostSnapshotOptions`.
- **Paths** — `defaultKubeconfigPath`, `defaultSiriusProvidersPath`, `defaultEmbersynthConfigPath`.
- **Planner allowlist** — `filterTools`, `DEFAULT_ALLOWLIST`, type `AllowlistConfig`. Deny-wins; an empty allow list fails closed.
- **Planner executor** — `runPlanner(opts)`, `stubPlannerExecutor`; types `PlannerExecutor`, `PlannerExecutorInput`, `PlannerExecutorResult`, `RunPlannerOptions`, `RunPlannerResult`.
- **LLM executor** — `createLlmExecutor(opts): PlannerExecutor`, type `CreateLlmExecutorOptions`. Wraps any `AiProvider` and forces the `submit_plan` tool via `tool_choice`.
- **Planner prompt** — `buildPlannerPrompt(opts)`.
- **Planner schema** — `PlanSchema`, `PlanStepSchema`; types `Plan`, `PlanStep`, `PlannerToolDescriptor`, `ToolSafetyTier` (`read | mutation-dry-run-safe | mutation-destructive`).

### Bind a real planner LLM

The default planner executor is a stub. Wire a real `AiProvider` with `createLlmExecutor` and pass it to `buildNovaMcpServer`:

```ts
import { createOpenAICompatProvider } from "@novaproto/contracts";
import { buildNovaMcpServer, createLlmExecutor } from "@novaproto/mcp";

const provider = createOpenAICompatProvider({
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
});

const server = buildNovaMcpServer({
  plannerExecutor: createLlmExecutor({ provider, model: "gpt-4o-mini" }),
});
```

For the pure (server-free) path, call `runPlanner({ goal, context, tools, allowlist, executor })` directly — it returns a discriminated `RunPlannerResult`.

### Cost snapshot without a server

```ts
import { computeCostSnapshot } from "@novaproto/mcp";

const snapshot = computeCostSnapshot({ days: 7 });
// snapshot.byProvider, snapshot.byModel, snapshot.totalEstimatedCostUsd
```

## Dependencies

Built on [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) `1.29.0`, [`@novaproto/contracts`](https://www.npmjs.com/package/@novaproto/contracts), and [`@novaproto/mcp-shared`](https://www.npmjs.com/package/@novaproto/mcp-shared). Internal `workspace:*` ranges are rewritten to concrete semver on publish, so consumers always pull a real version range.

## License

MIT
