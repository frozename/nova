# GEMINI.md — Nova

Gemini CLI entrypoint. Defers to [`AGENTS.md`](./AGENTS.md) as the
authoritative source; this file calls out Gemini-specific
conventions only.

## Before any task

1. Read `AGENTS.md` at the repo root (full rules, style, stack).
2. Read `README.md` if you need consumer-facing context.
3. If the task touches schemas in `@novaproto/contracts` or package
   dependencies, plan the cross-repo sync **before** editing —
   Nova is consumed by llamactl, sirius-gateway, embersynth.
   Schema changes are wire-shape changes.

## Non-negotiables

- **Nova is an SDK.** Resist adding llamactl- or sirius- or
  embersynth-specific shapes. Put them in the consumer repo.
- **Zod 4 only** — `z.record(z.string(), z.unknown())`,
  `.partial()`, `z.discriminatedUnion`. No Zod 3 idioms.
- **`workspace:*` for inter-package deps** — `bun pm pack` in the
  release workflow rewrites them to the exact version recorded in
  `bun.lock`; npm itself does not rewrite `workspace:` specs.
- **Bun** only — no `npm`, `yarn`, `pnpm`.
- **No framework deps in `@novaproto/contracts`.** It's schemas +
  interfaces. Zero runtime side effects.

## Runtime + commands

```bash
bun install
bun test               # all packages
bun run typecheck      # each package, in order
bun packages/mcp/bin/nova-mcp.ts
```

## Semver discipline for schema changes

`AGENTS.md` covers this in detail. Short version: any change to a
Zod schema in `@novaproto/contracts` is a wire-shape change. Bump the
package version; refresh every consumer's `bun install`; run every
consumer's test suite; commit lockfile bumps per consumer.

## Where to look

- `packages/contracts/src/` — schemas + interfaces.
- `packages/mcp-shared/src/` — audit, content, usage sink + reader.
- `packages/mcp/src/` — unified MCP facade, planner, cost snapshot.
- `packages/*/test/` — existing patterns before writing new ones.
