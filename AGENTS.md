# AGENTS.md — Nova

Agent instructions for any AI coding tool (Claude Code, Cursor,
Codex, Copilot) working in this repo. See `README.md` for the
user-facing overview.

## What this repo is

Nova is an AI-provider SDK + MCP server scaffolding:

- `@nova/contracts` — canonical Zod schemas + TS interfaces for
  chat, embeddings, models, health, stream, usage; `AiProvider`
  interface; OpenAI-compat adapter factory.
- `@nova/mcp-shared` — transport-agnostic helpers for MCP servers
  (audit sink, content envelopes, usage sink + reader).
- `@nova/mcp` — unified operator MCP facade. Consumer of the two
  above.

Nova is consumed via `file:` deps by sibling repos (`llamactl`,
`sirius-gateway`, `embersynth`, and anything else built on top).
**Nova does not know about its consumers.** Resist adding
llamactl/sirius/embersynth-specific shapes here; put them in the
consumer.

## Tech stack

- Bun 1.3+ (`bun test`, `bun install`, `bun run typecheck`).
- TypeScript 5.9+, `"type": "module"`, `.js` import specifiers on TS
  paths (standard NodeNext + ESM).
- Zod 4.3+ (`z.enum`, `z.discriminatedUnion`, `.partial()` for
  forward-compat record shapes).
- `@modelcontextprotocol/sdk` 1.29.0.
- `yaml` for the three operator YAMLs the MCP facade reads.
- **No framework** — no Nest, no Express, no tRPC in this repo.

## Layout

```
packages/
├── contracts/        @nova/contracts  — schemas + interfaces only
├── mcp-shared/       @nova/mcp-shared — audit + content + usage
└── mcp/              @nova/mcp        — operator MCP facade
```

Each package carries its own `package.json`, `tsconfig.json`, and
`test/`. Consumer ergonomics matter — keep `main` pointing at the
TS source (`src/index.ts`) so `file:` deps work without a build
step.

## Commands

```bash
bun install            # workspace install
bun test               # all packages
bun run typecheck      # each package, in sequence
bun packages/mcp/bin/nova-mcp.ts   # stdio MCP server
```

Every PR: `bun test && bun run typecheck` from the repo root before
committing.

## Code style

- **No comments that explain WHAT** — the identifier does that.
  Write comments for WHY (non-obvious constraints, workarounds,
  subtle invariants). Single-line max for most; reserve multi-line
  for module headers where the orientation earns it.
- **No unused backwards-compat shims** — if something is unused,
  delete it.
- **Zod 4 idioms:**
  - `z.record(z.string(), z.unknown())` (NOT `z.record(z.unknown())`
    — Zod 4 requires key + value).
  - `.default({})` on optional object fields when the default makes
    downstream code cleaner.
  - `z.object({...}).partial()` when you want "all fields optional
    but unknown keys stripped." Strict `z.record(EnumSchema, X)`
    forces all keys present — usually wrong for forward-compat.
  - `z.discriminatedUnion('type', [...])` for tagged unions; always
    tag the discriminator with `z.literal('...')`.
- **Fail closed** on validation boundaries. Malformed input at an
  MCP boundary → structured error response, never a thrown stack.
- **Fire-and-forget for hot paths.** `appendUsageBackground` swallows
  errors by design; never block a request on telemetry.

## Testing

- `bun:test` throughout. `describe` + `test`, `expect(...).to*`.
- Temp dirs for file I/O:
  ```ts
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nova-xyz-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  ```
- MCP integration tests use `InMemoryTransport.createLinkedPair()`;
  no subprocess needed.
- **Don't mock what you can construct.** For schema tests, build a
  real object and `.parse()` it. For MCP tests, build the real
  server + client and exercise the envelope.
- Clock injection: every writer / time-sensitive function takes
  `now?: () => Date` so tests are deterministic.

## Schema changes = semver event

Changing any Zod schema in `@nova/contracts` is a wire-shape change.
Follow this sequence:

1. Edit the schema + add/update tests.
2. `bun test && bun run typecheck` at the nova root.
3. Bump `version` in the affected package (`packages/contracts/package.json`).
4. In each downstream consumer (`llamactl`, `sirius-gateway`,
   `embersynth`, …), `bun install` refreshes the file: dep; then
   run that consumer's full test suite.
5. Commit the consumer's lockfile bump alongside any code changes
   the schema change required. One commit per consumer.

Never split a "nova schema" commit from its "consumer lockfile"
commit without a good reason — agents should batch.

## MCP facade (`@nova/mcp`) patterns

- Tool handlers are thin. Validate input at the Zod boundary
  (`inputSchema` in `registerTool`), call a pure helper in
  `src/cost/`, `src/planner/`, etc., then `appendAudit` + return
  `toTextContent(payload)`.
- Audit records: put outcome / executor / step-count under
  `result`. The audit interface persists a specific set of fields
  (server, tool, input, result, dryRun, actor) — arbitrary top-level
  keys get dropped.
- MCP SDK may not strictly enforce Zod `min(1)` at the transport
  boundary. Duplicate critical guards inside the handler (e.g.,
  `runPlanner` re-checks empty goal).
- Planner executor interface is injectable. Never bake a specific
  model binding into `@nova/mcp`; consumers pass executors at
  construction time via `buildNovaMcpServer({ plannerExecutor })`.

### Facade config (`~/.llamactl/nova-mcp.yaml`)

`@nova/mcp` is a unified facade over the three downstream servers
(`@llamactl/mcp`, `@sirius/mcp`, `@embersynth/mcp`). The facade reads
a YAML config at `~/.llamactl/nova-mcp.yaml` (overridable via
`NOVA_MCP_CONFIG`) that declares each downstream's transport.
`${VAR}` leaves are interpolated from `process.env` at load time;
unset vars keep the literal `${VAR}` placeholder so the operator sees
the breadcrumb. Missing file → one stderr warning, facade still boots
with its native `nova.*` tools. Malformed YAML or Zod validation
failure throws at boot.

Copy-pasteable example:

```yaml
version: 1
downstreams:
  - name: llamactl
    transport: stdio
    command: llamactl-mcp
    args: []
    env:
      LLAMACTL_MCP_TOKEN: ${LLAMACTL_MCP_TOKEN}
  - name: sirius
    transport: http
    url: http://127.0.0.1:4401/mcp
    token: ${SIRIUS_MCP_TOKEN}
  - name: embersynth
    transport: stdio
    command: embersynth-mcp
    args: []
    env:
      EMBERSYNTH_CONFIG: /path/to/embersynth.yaml
```

Schema source of truth: `packages/mcp/src/facade/config.ts`
(`NovaMcpConfigV1`, `DownstreamSpec`). `stdio` carries
`{command, args, env}`; `http` carries `{url, token?}` and is wired to
`StreamableHTTPClientTransport` with a bearer-auth `fetch` wrapper
(`packages/mcp/src/facade/auth.ts::createBearerAuth`).

### Native tools

Five tools live on the facade itself, regardless of downstream
availability:

- `nova.ops.overview` — reads the three operator YAMLs llamactl
  authors (kubeconfig, sirius-providers, embersynth) and returns a
  unified snapshot of agents + gateways + providers + profiles +
  synthetic models.
- `nova.ops.healthcheck` — probes each cloud-bound node's endpoint
  and reports per-node reachability; fails-soft so one flaky URL
  doesn't poison the report.
- `nova.ops.cost.snapshot` — rolls up usage + pricing into a cost
  report (via `@nova/mcp-shared::readUsage`/`loadPricing`).
- `nova.operator.plan` — natural-language goal → JSON plan of MCP
  tool calls; stub + LLM executor modes, injectable via
  `buildNovaMcpServer({ plannerExecutor })`.
- `nova.models.list` — aggregates each reachable downstream's model
  catalog (`llamactl.catalog.list`, `sirius.models.list`,
  `embersynth.synthetic.list`) in parallel, merges with a fixed
  priority (`llamactl` → `sirius` → `embersynth`), dedupes by `id`
  (first wins, later occurrences append to `alsoAvailableIn`), and
  tags each entry with its `provenance`. Partial failures surface
  under `partial: {failed, errors}`; the facade still returns what
  it could collect.

### Passthrough layer

Every tool from a configured downstream becomes callable at the
facade under its original, fully-qualified name. No renaming — an
`embersynth.nodes.inspect` tool stays `embersynth.nodes.inspect` on
the facade. Boot sequence:

1. `loadConfig()` reads the YAML.
2. `bootAll(config)` (`Promise.allSettled`) opens an MCP `Client`
   per downstream. Failed downstreams log to stderr and are omitted;
   the facade boots partial.
3. `mountProxyTools(server, downstreams)` calls `client.listTools()`
   on each and registers a 1:1 proxy handler on the upstream server.
   Collisions → first wins, stderr warning.

Snapshot is taken **at boot only** — no hot reload. If a downstream
restarts, the facade's proxy handlers call through a dead client and
surface the error; the operator restarts the facade to pick up new
tools. Reconnect / live-refresh is a future slice, not a bug.

### What to avoid (facade-specific)

- Dynamic re-discovery of downstream tools at call time. Boot-time
  snapshot is the contract; clients should not observe surface
  changes without a restart.
- Renaming proxied tools (stripping the `llamactl.` / `sirius.` /
  `embersynth.` prefix). Namespace preservation is load-bearing —
  operators and agents reason about provenance by prefix.
- Caching proxied responses. Every call passes through.
- `SSEClientTransport` — deprecated in SDK 1.29.0. Use
  `StreamableHTTPClientTransport` for HTTP downstreams.
- `server.setRequestHandler(...)` — old low-level API. Always
  `server.registerTool(...)`.

## What to avoid

- Importing from `@llamactl/*`, `@sirius/*`, or `@embersynth/*` —
  Nova is the dependency, not the dependent.
- Adding runtime deps to `@nova/contracts`. It's schemas +
  interfaces; no HTTP, no SDK wrappers, no file I/O.
- Committing `.env` or secrets.
- `z.record(z.unknown())` (Zod 3 shape — compile-errors in Zod 4).
- `workspace:*` deps between Nova's own packages. They break
  resolution when a consumer links `@nova/mcp` via `file:`. Use
  `file:../sibling` instead.

## When in doubt

1. Check the sibling package's tests for a pattern.
2. Read the package's `README`/`AGENTS.md` at the repo root.
3. If a change touches multiple packages or consumers, write a plan
   first (describe the cross-repo sequence + expected test counts)
   before editing.
