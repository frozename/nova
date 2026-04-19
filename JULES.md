# JULES.md — Nova

Jules (Google's async coding agent) entrypoint. Defers to
[`AGENTS.md`](./AGENTS.md) as the authoritative source.

Jules runs asynchronously in a cloud VM and produces a PR. Treat
every task as "produce one focused commit that ships cleanly,"
because you won't be there to iterate.

## Before opening a PR

1. Read `AGENTS.md` at the repo root.
2. Identify which package(s) the issue touches: `@nova/contracts`,
   `@nova/mcp-shared`, `@nova/mcp`.
3. Run `bun install && bun test && bun run typecheck`. If any of
   those are red before your change, report and stop — don't try
   to fix preexisting failures alongside a feature.

## Scope rules

- **One slice per PR.** Don't bundle a schema change with an
  unrelated refactor. Reviewers need to reason about one
  semantically-cohesive change.
- **Cross-repo sync is the user's responsibility**, not yours. If
  your change bumps `@nova/contracts`, note it in the PR body so
  the user can plan the downstream `bun install` sweep across
  llamactl, sirius-gateway, embersynth.
- **Tests before code** when feasible. Every new behaviour needs a
  `bun:test` in the relevant package's `test/` dir.

## Non-negotiables

- **Nova is an SDK.** No llamactl/sirius/embersynth-specific shapes.
- **Zod 4 idioms.** No `z.record(z.unknown())`.
- **`file:../sibling` deps** between Nova packages, not `workspace:*`.
- **Bun** only.
- **No framework deps in `@nova/contracts`.**
- **No AI / tool attribution** in commit messages.

## PR body checklist

Every PR Jules opens should include:

- The problem (link to issue).
- The approach (2-3 sentences).
- Test deltas (file / count).
- Downstream impact: does this touch a wire-shape schema? If yes,
  list the consumer repos that need a lockfile bump.
- Anything explicitly deferred.

## Commands Jules should know

```bash
bun install
bun test
bun run typecheck
bun packages/mcp/bin/nova-mcp.ts    # only for local manual
                                      verification; not in CI
```
