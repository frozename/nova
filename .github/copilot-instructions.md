# GitHub Copilot Instructions — Nova

Condensed digest. The authoritative rules live in [`AGENTS.md`](../AGENTS.md).

## What this repo is

AI provider SDK + MCP server scaffolding. Monorepo of three
packages:

- `@novaproto/contracts` — Zod schemas + TS interfaces for chat,
  embeddings, models, health, stream, usage. `AiProvider` interface.
  OpenAI-compat adapter factory.
- `@novaproto/mcp-shared` — audit sink, content envelopes, usage sink +
  reader for MCP servers.
- `@novaproto/mcp` — unified operator MCP facade (planner, cost
  snapshot).

Consumers (llamactl, sirius-gateway, embersynth) pull Nova via
`file:` deps.

## Stack

- Bun 1.3+, TypeScript 5.9+, Zod 4.3+.
- `@modelcontextprotocol/sdk` 1.29.
- No frameworks (no Nest, no Express, no tRPC in Nova).

## Hard rules

- **No llamactl/sirius/embersynth-specific code** in Nova. It's the
  dependency, never the dependent.
- **Zod 4 idioms only** — `z.record(z.string(), z.unknown())`,
  `.partial()`, `z.discriminatedUnion`.
- **`workspace:*` between Nova packages** — `bun pm pack` in the
  release workflow rewrites them to the exact version recorded in
  `bun.lock`; npm itself does not rewrite `workspace:` specs.
- **`@novaproto/contracts` has zero runtime deps.** Schemas + interfaces.
- **Bun** for all commands.
- **English** identifiers only.
- **No comments for what.** Comments for WHY.
- **No tool attribution** in commit messages.

## Tests

- `bun:test`. `beforeEach` for tempdirs. Clock injection via
  `now?: () => Date`.
- MCP integration tests use `InMemoryTransport.createLinkedPair()`.

## Layout

```
packages/
├── contracts/        schemas + interfaces
├── mcp-shared/       audit, content, usage utilities
└── mcp/              operator MCP facade
```

## Schema change = semver event

Editing a schema in `@novaproto/contracts` is a wire-shape change. Bump
the package version + note in the PR body which consumers need a
lockfile refresh (llamactl, sirius-gateway, embersynth).
