# Nova

Shared infrastructure for the llamactl family (llamactl,
sirius-gateway, embersynth). Monorepo housing the packages every
consumer pulls from — canonical AI-provider contracts, MCP server
helpers, and the unified operator MCP facade.

## Packages

| Package | Role |
|---|---|
| `@nova/contracts` | Canonical AI-provider contracts — chat, embeddings, models, health, stream, usage schemas; `AiProvider` interface; OpenAI-compat adapter factory. |
| `@nova/mcp-shared` | Cross-cutting helpers for llamactl-family MCP servers — audit sink, content envelopes, usage-record sink, usage reader. |
| `@nova/mcp` | Unified operator MCP facade. Roll-up tools (`nova.ops.overview`, `nova.ops.healthcheck`, `nova.ops.cost.snapshot`) plus `nova.operator.plan` — the LLM-backed intent-to-plan translator. |

## Scope rules

- **Contracts** — Zod schemas + TypeScript interfaces that cross repo
  boundaries. No HTTP, no SDK wrappers, no file I/O.
- **mcp-shared** — thin utilities every MCP server in the family
  wants (audit logging, usage recording, content envelope helper). No
  server construction, no tool logic.
- **mcp** — operator-facing MCP server. Reads sibling repos'
  operator YAMLs (kubeconfig, sirius-providers, embersynth config,
  usage JSONL) and surfaces them through a single stdio-MCP endpoint.
  Depends on `@nova/mcp-shared`.

If a new cross-repo concern emerges — unified telemetry, auth, a new
adapter family — add it as `@nova/<slug>` here rather than vendoring
into each consumer.

## `@nova/mcp` surface

Tools exposed by `nova-mcp` (stdio transport):

| Tool | Purpose |
|---|---|
| `nova.ops.overview` | Unified snapshot — agents + gateways + sirius providers + embersynth profiles + synthetic models. Reads the three operator YAMLs. |
| `nova.ops.healthcheck` | GET-probe every gateway + sirius provider baseUrl; fails soft per probe. |
| `nova.ops.cost.snapshot` | Aggregates recorded usage JSONL (last N days, default 7) into per-provider + per-(provider, model) roll-ups. Tokens + request counts + avg latency. Pricing join is a follow-up. |
| `nova.operator.plan` | Translate a natural-language operational goal into a validated PlanSchema sequence of MCP tool calls. Default executor is a canned stub — inject a real LLM executor (N.4.3 follow-up) to drive planning with a live model. |

### Planner (`nova.operator.plan`)

The planner ships in three pure pieces plus an executor seam:

- **Schema** (`@nova/mcp/planner/schema`) — `PlanSchema` (20-step hard
  cap, required per-step annotations, top-level reasoning),
  `PlannerToolDescriptor`, `ToolSafetyTier`.
- **Allowlist** (`@nova/mcp/planner/allowlist`) — `filterTools()` +
  `DEFAULT_ALLOWLIST`. Glob-aware (`llamactl.*`), deny wins over
  allow, destructive tier requires explicit opt-in, bare `*` never
  auto-grants destructive. Fail-closed on empty allow.
- **Prompt** (`@nova/mcp/planner/prompt`) — `buildPlannerPrompt({
  tools, context, goal })` emits deterministic system + user messages
  and an OAI-compatible `submit_plan` function schema.
- **Executor** (`@nova/mcp/planner/executor`) — `PlannerExecutor`
  interface + canned `stubPlannerExecutor` + `runPlanner()` composer
  (allowlist → prompt → executor → PlanSchema.safeParse, discriminated
  result).

Every piece is pure + unit-tested; the MCP tool handler is the thin
audit/envelope layer.

## Consuming Nova

Until a registry publish lands, consumers depend on Nova via a local
path to a specific workspace package:

```json
{
  "dependencies": {
    "@nova/contracts": "file:../nova/packages/contracts",
    "@nova/mcp-shared": "file:../nova/packages/mcp-shared"
  }
}
```

Each consumer installs its own copy under `node_modules`; schema
drift between consumers is detected by the cross-repo test sweep.
The expectation is that the repos sit side-by-side:

```
~/dev/
├── nova/
├── llamactl/
├── sirius-gateway/
└── embersynth/
```

## Editing Nova

1. Change a package under `packages/<name>/` and run
   `bun test && bun run typecheck` at the repo root.
2. Bump `version` in the changed package following semver intent
   (wire-shape changes are breaking; additive schemas are minor;
   docstring-only are patch).
3. In each downstream consumer repo, run `bun install` to refresh the
   file: dep lockfile, exercise its test suite, commit the lockfile
   bump alongside any follow-up code changes. These sync events are
   deliberate — one commit per consumer — not continuous.

## Layout

```
packages/
├── contracts/                 # @nova/contracts
│   ├── src/
│   │   ├── provider.ts
│   │   ├── providers/openai-compat.ts
│   │   └── schemas/{chat,embeddings,health,models,stream,usage}.ts
│   └── test/
├── mcp-shared/                # @nova/mcp-shared
│   ├── src/{audit,content,usage,usage-reader,index}.ts
│   └── test/
└── mcp/                       # @nova/mcp
    ├── bin/nova-mcp.ts
    ├── src/
    │   ├── cost/snapshot.ts
    │   ├── planner/{schema,allowlist,prompt,executor}.ts
    │   ├── paths.ts
    │   └── server.ts
    └── test/
```

## Running nova-mcp

```bash
bun install
bun packages/mcp/bin/nova-mcp.ts
# stdio MCP server — wire it into a client (Claude Desktop, etc.)
```

## Tests

```bash
bun test           # all three packages
bun run typecheck  # each package, in order
```
