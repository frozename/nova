# Nova

Canonical AI-provider contracts shared by the llamactl family
(llamactl, sirius-gateway, embersynth).

## Scope

- Zod schemas for wire types (chat, embeddings, models, health, stream events).
- TypeScript interfaces for runtime abstractions (`AiProvider`, `ProviderRegistry`).
- One concrete adapter factory (`createOpenAICompatProvider`) so consumers don't each re-write the OpenAI-compat dialect glue.

No HTTP, no SDK wrappers, no file I/O. If it crosses a repo boundary,
it belongs here.

## Layout

```
src/
├── index.ts                 # re-exports every public type
├── provider.ts              # AiProvider, ProviderFactory, ProviderRegistry
├── providers/
│   └── openai-compat.ts     # the OpenAI-compatible adapter factory
└── schemas/
    ├── chat.ts
    ├── embeddings.ts
    ├── health.ts
    ├── models.ts
    └── stream.ts
```

## Consuming Nova

Until a registry publish lands, consumers depend on Nova via a local
path:

```json
{
  "dependencies": {
    "@nova/contracts": "file:../nova"
  }
}
```

Each consumer installs their own copy under `node_modules`; schema
drift between consumers is detected by the cross-repo test sweep
(see each repo's CI).

## Editing Nova

1. Change `src/` and run `bun test && bun run typecheck`.
2. Bump `version` in `package.json` following semver intent (chat shape
   changes are breaking; additive schemas are minor; docstring-only are
   patch).
3. Update each consumer to the new version in a dedicated commit per
   repo — Nova upgrades are deliberate sync events, not continuous
   integration obligations.
