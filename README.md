# Nova

An AI provider SDK + MCP server scaffolding. One canonical vocabulary
for chat, embeddings, models, streams, health, and usage — plus the
adapter factories and MCP helpers everyone needs when building an AI
gateway, agentic harness, or operator surface.

Nova stays transport-agnostic and runtime-agnostic: Zod schemas,
TypeScript interfaces, and a handful of pure helpers. No opinions
about how you serve, route, bill, or observe requests — just the
contracts every layer of that stack has to speak.

## Packages

| Package | Role |
|---|---|
| `@nova/contracts` | Canonical AI-provider contracts. Chat, embeddings, models, health, stream, usage schemas. `AiProvider` interface. Factory for OpenAI-compat adapters that covers chat + embeddings + streaming (content + tool-call deltas) out of the box. |
| `@nova/mcp-shared` | Cross-cutting helpers for MCP servers that expose operator surfaces — audit sink, content envelope helper, usage-record sink + reader. Transport-agnostic; plug into any MCP server. |
| `@nova/mcp` | Unified operator MCP server — roll-up tools over sibling YAML configs + usage JSONL, plus `nova.operator.plan`, the LLM-backed intent-to-plan translator. Optional; a reference consumer of the two layers above. |

## Why

Pick any AI-gateway-ish problem — routing requests across providers,
logging usage, fronting OpenAI-compat to a bespoke backend, writing
an MCP tool that queries model health, teaching an LLM to fill out
an operator runbook. Each one re-derives the same primitives:

- "What do a chat request and response look like on the wire?"
- "How do I stream content + tool calls?"
- "What shape is usage data in?"
- "How do I expose this surface through MCP without re-inventing
  audit and content envelopes?"

Nova answers those once. Adapter fixes land in one place; schema
changes propagate on `bun install`.

## `@nova/contracts` — the SDK core

Every type that crosses a process boundary:

- **Chat** — `ChatRequestSchema`, `ChatResponseSchema`,
  `StreamEventSchema`. Content blocks, tool calls, role / finish
  reason enums, tool-call delta preservation in streaming.
- **Embeddings** — `EmbeddingRequestSchema`,
  `EmbeddingResponseSchema`. Single + batch inputs.
- **Models** — `ModelInfoSchema` for `/v1/models`-shaped listings.
- **Health** — `ProviderHealthSchema`.
- **Usage** — `UsageRecordSchema`: ts, provider, model, kind,
  prompt/completion/total tokens, latency, optional request_id +
  estimated_cost_usd + user + route.
- **AiProvider** interface — `createResponse`, `streamResponse`,
  `createEmbeddings`, `healthCheck`, `listModels`. Implement once,
  plug into anything that speaks Nova.

`createOpenAICompatProvider({ name, baseUrl, apiKeyRef?, healthPath? })`
produces a full `AiProvider` for any OpenAI-compatible endpoint:
chat (streaming + non-streaming), embeddings, tool calls, finish-
reason mapping, model listing, `GET /models` or custom `healthPath`
probing. Used by every consumer in the family.

## `@nova/mcp-shared` — MCP server scaffolding

Thin utilities every MCP server wants:

- `appendAudit({ server, tool, input, result? })` — JSONL audit sink
  at `~/.llamactl/mcp/audit/<server>-<YYYY-MM-DD>.jsonl`. Every
  mutation tool records one line per invocation.
- `toTextContent(payload)` — wraps a JSON payload in the MCP `{
  content: [{ type: 'text', text }] }` envelope. Keeps the
  JSON.stringify detail out of each tool handler.
- `appendUsage` / `appendUsageBackground` — UsageRecord writer with
  the same rotation semantics as the audit sink. Fire-and-forget
  variant for hot paths.
- `readUsage({ since, until, provider, dir })` — batch reader over
  the JSONL corpus with day-boundary pre-filtering + torn-write
  tolerance. Consumed by cost aggregators.

Drop into any MCP server (your own, or `@nova/mcp`) without pulling
framework dependencies.

## `@nova/mcp` — unified operator MCP facade

Optional but useful: a stdio MCP server that rolls up the YAMLs a
multi-provider AI deployment typically writes and surfaces them
through a single MCP endpoint.

| Tool | Purpose |
|---|---|
| `nova.ops.overview` | Unified snapshot — agents + gateways + providers + profiles + synthetic models. Reads sibling operator YAMLs when present. |
| `nova.ops.healthcheck` | GET-probe every gateway + provider `baseUrl`; fails soft per probe. |
| `nova.ops.cost.snapshot` | Aggregates recorded usage JSONL over the last N days into per-provider + per-(provider, model) roll-ups. |
| `nova.operator.plan` | Translate a natural-language operator goal into a validated PlanSchema sequence of MCP tool calls. Default executor is a canned stub; bind your own LLM executor for real planning. |

### Planner (`nova.operator.plan`)

Four pure pieces:

- **Schema** — `PlanSchema` (20-step hard cap, required per-step
  annotations, top-level reasoning), `PlannerToolDescriptor`,
  `ToolSafetyTier`.
- **Allowlist** — `filterTools()` + `DEFAULT_ALLOWLIST`. Glob-aware
  (`myservice.*`), deny wins over allow, destructive tier requires
  explicit opt-in, bare `*` never auto-grants destructive. Fail-
  closed on empty allow.
- **Prompt** — `buildPlannerPrompt({ tools, context, goal })` emits
  deterministic system + user messages and an OAI-compatible
  `submit_plan` function schema.
- **Executor** — `PlannerExecutor` interface + canned
  `stubPlannerExecutor` + `runPlanner()` composer (allowlist →
  prompt → executor → `PlanSchema.safeParse`, discriminated result).

Every piece is pure + unit-tested; the MCP tool handler is the thin
audit/envelope layer.

## Consuming Nova

Until a registry publish lands, consumers depend on Nova via local
file paths. Typical layout:

```
~/dev/
├── nova/
├── my-gateway/
├── my-agent/
└── ...
```

```json
{
  "dependencies": {
    "@nova/contracts": "file:../nova/packages/contracts",
    "@nova/mcp-shared": "file:../nova/packages/mcp-shared"
  }
}
```

Each consumer installs its own copy under `node_modules`; schema
drift is detected by running the consumer's test suite after a Nova
bump.

### Example — build a provider adapter

```ts
import { createOpenAICompatProvider } from '@nova/contracts';

const provider = createOpenAICompatProvider({
  name: 'together',
  baseUrl: 'https://api.together.xyz/v1',
  apiKeyRef: '$TOGETHER_API_KEY',
});

const response = await provider.createResponse({
  model: 'meta-llama/Llama-3.3-70B-Instruct',
  messages: [{ role: 'user', content: 'hello' }],
});
```

### Example — log usage

```ts
import { appendUsageBackground } from '@nova/mcp-shared';

appendUsageBackground({
  record: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    kind: 'chat',
    prompt_tokens: 42,
    completion_tokens: 17,
    total_tokens: 59,
    latency_ms: 310,
    ts: new Date().toISOString(),
  },
});
```

### Example — MCP server with audit

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appendAudit, toTextContent } from '@nova/mcp-shared';

const server = new McpServer({ name: 'my-service', version: '0.0.0' });

server.registerTool('my.service.status', { /* schema */ }, async (input) => {
  const status = await checkStatus();
  appendAudit({ server: 'my-service', tool: 'my.service.status', input });
  return toTextContent(status);
});
```

## Editing Nova

1. Change a package under `packages/<name>/` and run
   `bun test && bun run typecheck` at the repo root.
2. Bump `version` in the changed package following semver intent
   (wire-shape changes are breaking; additive schemas are minor;
   docstring-only are patch).
3. In each downstream consumer, run `bun install` to refresh the
   lockfile, then run that consumer's test suite. Commit the
   lockfile bump alongside any follow-up code changes.

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
# stdio MCP server — wire into Claude Desktop or any MCP client.
```

## Tests

```bash
bun test           # all packages
bun run typecheck  # each package, in order
```

## Reference consumers

Real-world apps built on Nova (source + live usage examples):

- [llamactl](https://github.com/frozename/llamactl) — single-
  operator control plane for llama.cpp fleets. Uses every Nova
  package.
- [sirius-gateway](https://github.com/frozename/sirius-gateway) —
  multi-provider AI gateway with OpenAI-compatible routes. Adapters
  delegate to `@nova/contracts`.
- [embersynth](https://github.com/frozename/embersynth) —
  capability-based distributed AI orchestration runtime. OpenAI-
  compatible adapter delegates to Nova's provider factory.

## License

MIT.
