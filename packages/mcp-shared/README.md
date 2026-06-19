# @novaproto/mcp-shared

[![npm version](https://img.shields.io/npm/v/@novaproto/mcp-shared.svg)](https://www.npmjs.com/package/@novaproto/mcp-shared)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Node--portable-339933.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](../../tsconfig.base.json)

**MCP server scaffolding for the `llamactl` family — the audit, usage, and pricing sinks every operator tool re-derives otherwise.**

_Append-only JSONL sinks, the MCP content envelope, and a YAML pricing/cost layer. Write the side-effects once; build your tools on top._

Part of [Nova](https://github.com/frozename/nova), the shared contract layer for multi-provider AI systems. This package sits between [`@novaproto/contracts`](https://www.npmjs.com/package/@novaproto/contracts) (the schemas) and [`@novaproto/mcp`](https://www.npmjs.com/package/@novaproto/mcp) (the unified operator facade).

## What it is

Every MCP server that touches a provider has to do the same boring, get-it-wrong-once things: record what it did (audit), record what it cost (usage), wrap a payload in the MCP `content` envelope, and turn token counts into dollars (pricing). `@novaproto/mcp-shared` is those four things, written once, as **node-portable** code — no `bun:*` or `Bun.*` imports, so it runs on plain Node.js and Bun alike.

The sinks are deliberately dumb byte writers: append-only JSONL, one file per `(subject, day)`, readable with `cat <dir>/*.jsonl | jq`. Schema validation lives at the adapter boundary in `@novaproto/contracts`; this package just writes the lines.

## Install

```sh
npm install @novaproto/mcp-shared
# or: bun add @novaproto/mcp-shared
```

Range in `package.json`: `"@novaproto/mcp-shared": "^0.1.0"`. Depends on [`@novaproto/contracts`](https://www.npmjs.com/package/@novaproto/contracts) for the shared usage/pricing schemas and on `yaml` for pricing catalogs.

## Helpers

### Audit sink — `appendAudit`, `defaultAuditDir`

Append one audit record (returns the written `AuditRecord`). JSONL at `~/.llamactl/mcp/audit/<server>-<YYYY-MM-DD>.jsonl`; override the directory with the `LLAMACTL_MCP_AUDIT_DIR` env var or the `dir` option.

```ts
import { appendAudit } from "@novaproto/mcp-shared";

appendAudit({
  server: "my-service",
  tool: "my.service.delete",
  input: { id: "abc" },
  dryRun: true, // optional; defaults to false
});
```

### Content envelope — `toTextContent`

MCP tool handlers return `{ content: [{ type: "text", text }] }`. `toTextContent` serializes any payload into that shape (pretty-printed JSON).

```ts
import { toTextContent } from "@novaproto/mcp-shared";

return toTextContent({ ok: true, count: 3 });
// → { content: [{ type: "text", text: "{\n  \"ok\": true,\n  \"count\": 3\n}" }] }
```

### Usage sink — `appendUsage`, `appendUsageBackground`, `defaultUsageDir`

Record token usage as JSONL at `~/.llamactl/usage/<provider>-<YYYY-MM-DD>.jsonl` (env override `LLAMACTL_USAGE_DIR`, or `DEV_STORAGE`).

- `appendUsage(opts)` returns the written file path; it **throws** if `record.provider` is missing or empty (fail closed — an unattributed cost record is a bug).
- `appendUsageBackground(opts)` is fire-and-forget: it swallows errors so a logging failure never breaks the request path.

```ts
import { appendUsageBackground } from "@novaproto/mcp-shared";

// off the request path — record matches the UsageRecord shape from @novaproto/contracts
queueMicrotask(() =>
  appendUsageBackground({
    record: {
      ts: new Date().toISOString(),
      provider: "openai",
      model: "gpt-4o-mini",
      kind: "chat",
      prompt_tokens: 12,
      completion_tokens: 48,
      total_tokens: 60,
      latency_ms: 320,
    },
  }),
);
```

### Usage reader — `readUsage`

Read usage records back across the day-partitioned JSONL files. Returns `{ records, filesScanned, malformedLines }` — torn-write tolerant (a half-written final line is counted, not thrown). Filter with `since` / `until` (ISO timestamps) and `provider`; a cheap day-boundary pre-filter skips files outside the window before parsing.

```ts
import { readUsage } from "@novaproto/mcp-shared";

const { records, malformedLines } = readUsage({
  provider: "openai",
  since: "2026-06-01T00:00:00Z",
});
```

### Pricing + cost — `loadPricing`, `estimateCostUsd`, `computeCost`, `findModelPricing`, `defaultPricingDir`

Load YAML pricing catalogs and turn token counts into dollars. Catalogs live under `defaultPricingDir()` (`LLAMACTL_PRICING_DIR`, or `$DEV_STORAGE/pricing`, or `~/.llamactl/pricing`); malformed YAML files are skipped, never thrown.

```ts
import { loadPricing, estimateCostUsd } from "@novaproto/mcp-shared";

const { catalog } = loadPricing();
const usd = estimateCostUsd(record, catalog); // number | undefined (undefined when the model isn't priced)
```

- `computeCost(pricing, promptTokens, completionTokens)` — the raw arithmetic against a single `ModelPricing` entry.
- `findModelPricing(provider, model, catalog)` — the raw `{ provider, model }` pricing entries, for rendering a rate rather than just the final figure.

## Exports

`appendAudit`, `defaultAuditDir`, `toTextContent`, `appendUsage`, `appendUsageBackground`, `defaultUsageDir`, `readUsage`, `loadPricing`, `estimateCostUsd`, `computeCost`, `findModelPricing`, `defaultPricingDir`, plus the types `AuditRecord`, `AuditOptions`, `TextContentEnvelope`, `UsageWriteOptions`, `UsageReadOptions`, `UsageReadResult`, `LoadPricingOptions`, `LoadPricingResult`.

## License

MIT
