# Nova

Shared infrastructure for the llamactl family (llamactl,
sirius-gateway, embersynth). Monorepo housing the packages every
consumer pulls from.

## Packages

| Package | Role |
|---|---|
| `@nova/contracts` | Canonical AI-provider contracts — chat, embeddings, models, health, stream schemas; `AiProvider` interface; OpenAI-compat adapter factory. |
| `@nova/mcp-shared` | Cross-cutting helpers for llamactl-family MCP servers — audit sink, content envelopes, dry-run scaffolding. |

## Scope rules

- **Contracts** — Zod schemas + TypeScript interfaces that cross repo
  boundaries. No HTTP, no SDK wrappers, no file I/O.
- **mcp-shared** — thin utilities that every MCP server in the family
  wants (audit logging, dry-run preview shape, content envelope
  helper). No server construction, no tool logic.

If a new cross-repo concern emerges — unified telemetry, auth, a new
adapter family — add it as `@nova/<slug>` here rather than vendoring
into each consumer.

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
drift between consumers is detected by the cross-repo test sweep
(see each repo's CI).

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
├── contracts/               # @nova/contracts
│   ├── src/
│   │   ├── index.ts
│   │   ├── provider.ts
│   │   ├── providers/openai-compat.ts
│   │   └── schemas/{chat,embeddings,health,models,stream}.ts
│   └── test/
└── mcp-shared/              # @nova/mcp-shared
    ├── src/{audit,content,index}.ts
    └── test/
```
