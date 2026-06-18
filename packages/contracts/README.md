# @novaproto/contracts

Canonical AI-provider contracts shared across the llamactl family
(llamactl, sirius-gateway, embersynth): chat, embeddings, models,
health, streaming, usage, and pricing schemas, plus the
OpenAI-compatible provider interface.

The package is **node-portable** — it has no `bun:*` or `Bun.*`
dependencies and runs on Node.js and Bun alike.

## Install

```sh
npm install @novaproto/contracts
```

## Usage

```ts
import { type AiProvider, type UnifiedAiRequest } from "@novaproto/contracts";
```

Schemas are authored with [zod](https://github.com/colinhacks/zod);
the package re-exports both the runtime validators and their inferred
types.

## License

MIT
