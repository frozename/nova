# @novaproto/contracts

[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@novaproto/contracts.svg)](https://www.npmjs.com/package/@novaproto/contracts)
[![runtime Node-portable](https://img.shields.io/badge/runtime-Node--portable-339933.svg)](https://nodejs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](../../tsconfig.base.json)

**One vocabulary for every AI provider.** The Zod-validated contract layer
every gateway, agent harness, and operator surface otherwise re-derives.

_Schemas for chat, embeddings, models, streaming, health, usage, and pricing —
plus the `AiProvider` interface and an OpenAI-compatible adapter factory._

This is the SDK core of [Nova](https://github.com/frozename/nova). It carries
**zero runtime logic of its own beyond `zod`** (`dependencies: { zod: ^4.3.6 }`):
schemas for the types that cross the wire, TypeScript interfaces for the runtime
abstractions, and one concrete adapter factory for the OpenAI REST dialect.
Implement `AiProvider` once; route, bill, observe, and proxy everywhere.

## Install

```sh
npm install @novaproto/contracts
# or: bun add @novaproto/contracts
```

Range in `package.json`: `"@novaproto/contracts": "^0.1.0"`.

## What it gives you

Each capability below is backed by a real export from
[`src/`](./src) — no invented surface.

- **Canonical chat wire types** — `UnifiedAiRequestSchema` /
  `UnifiedAiResponseSchema` (+ inferred `UnifiedAiRequest` /
  `UnifiedAiResponse`), `ChatMessageSchema`, `ContentBlockSchema`
  (discriminated union of text / `image_url` / input-audio blocks),
  `ToolSchema`, `ToolCallSchema`, `ToolChoiceSchema`,
  `ResponseFormatSchema` (`text` / `json_object` / `json_schema`),
  `RoleSchema`, `FinishReasonSchema`, `UsageSchema`.
- **Streaming events** — `UnifiedStreamEventSchema`, a discriminated union of
  `chunk` / `tool_call` / `error` / `done`, with tool-call delta preservation
  (`UnifiedStreamChunkSchema`, `StreamChoiceSchema`, `StreamDeltaSchema`).
- **Embeddings** — `UnifiedEmbeddingRequestSchema` /
  `UnifiedEmbeddingResponseSchema`, `EmbeddingRowSchema`; string / array /
  token-array input union, `encoding_format`, `dimensions`.
- **Models catalog** — `ModelInfoSchema`, `ModelListResponseSchema`,
  `ModelCapabilitySchema`, `ModelCostSchema`.
- **Health** — `ProviderHealthSchema`, `ProviderHealthStateSchema`
  (`healthy` / `degraded` / `unhealthy` / `unknown`).
- **Usage record** — `UsageRecordSchema` and `UsageKindSchema`. Privacy lock by
  construction: it records token counts, not content.
- **Pricing** — `ModelPricingSchema`, `ProviderPricingSchema`, and the
  `PricingCatalog` type (`Map<string, ProviderPricing>`).
- **Retrieval (RAG)** — `SearchRequest` / `SearchResponse`, `StoreRequest` /
  `StoreResponse`, `DeleteRequest` / `DeleteResponse`,
  `ListCollectionsResponse`, `DocumentSchema`, `SearchResultSchema`,
  `CollectionInfoSchema`. Score is cosine similarity normalized `0..1`.
- **Runtime abstractions** (TypeScript interfaces, not Zod) — `AiProvider`
  (`createResponse`, optional `streamResponse` / `createEmbeddings` /
  `listModels` / `healthCheck`), `RetrievalProvider`, `ProviderFactory` /
  `ProviderFactoryInput`, `ProviderRegistry`.
- **OpenAI-compat adapter factory** — `createOpenAICompatProvider(opts):
AiProvider`. Covers non-streaming and SSE streaming (content + tool-call
  deltas), embeddings, `listModels`, and `healthCheck`; fires an `onUsage` hook
  after each successful call; strips Nova-only `capabilities` /
  `providerOptions` before going on the wire. Also exports
  `mergeRequestHeaders`, `OpenAICompatUsageSnapshot`, `OpenAICompatOnUsage`.

## Example

Build a provider for any OpenAI-compatible upstream — OpenAI itself, Together,
groq, Mistral, or a local `llama-server`:

```ts
import { createOpenAICompatProvider } from "@novaproto/contracts";

const provider = createOpenAICompatProvider({
  name: "together",
  baseUrl: "https://api.together.xyz/v1",
  apiKey: process.env.TOGETHER_API_KEY!,
});

const res = await provider.createResponse({
  model: "meta-llama/Llama-3.3-70B-Instruct",
  messages: [{ role: "user", content: "hello" }],
});

console.log(res.choices[0].message.content, res.latencyMs, res.provider);
```

`OpenAICompatOptions` fields: `name`, `displayName?`, `baseUrl`, `apiKey`,
`fetch?`, `extraHeaders?`, `healthPath?` (default `/models`), `onUsage?`.

The adapter is kept deliberately thin — no retry loop, no failover, no logging.
Those belong in the orchestrator that composes providers. To persist usage,
wire the `onUsage` hook to the JSONL sink in
[`@novaproto/mcp-shared`](https://www.npmjs.com/package/@novaproto/mcp-shared).

## Node-portable

The package has no `bun:*` or `Bun.*` dependencies — it runs on plain Node.js
and on Bun alike. It builds to `dist/src/*.js` + `.d.ts` via `tsc --build`, and
`main` / `types` point at the compiled JavaScript. Bun is the monorepo's dev and
CI runtime only; consumers are not required to adopt it.

## License

MIT — part of the [Nova](https://github.com/frozename/nova) monorepo. See the
[root README](https://github.com/frozename/nova#readme) for the sibling
packages `@novaproto/mcp-shared` and `@novaproto/mcp`, and the architecture
overview.
