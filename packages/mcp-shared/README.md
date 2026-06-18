# @nova/mcp-shared

Cross-cutting helpers for llamactl-family MCP servers: audit sink,
content envelopes, dry-run scaffolding, and usage/pricing readers.

The package is **node-portable** — it has no `bun:*` or `Bun.*`
dependencies and runs on Node.js and Bun alike.

## Install

```sh
npm install @nova/mcp-shared
```

## Usage

```ts
import { appendAudit, toTextContent } from "@nova/mcp-shared";
```

Depends on [`@nova/contracts`](https://www.npmjs.com/package/@nova/contracts)
for the shared provider/usage/pricing schemas.

## License

MIT
