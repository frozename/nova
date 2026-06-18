# @novaproto/mcp

Unified MCP facade — a single operator entry point that rolls up tools
across the llamactl-family servers (llamactl, sirius-gateway,
embersynth). Serves native `nova.*` tools (ops overview, healthcheck,
cost snapshot, operator plan, models list) and 1:1-proxies every tool
advertised by each configured downstream.

The package is **node-portable** — its library and CLI entry have no
`bun:*` or `Bun.*` dependencies and run on Node.js and Bun alike.

## Install

```sh
npm install @novaproto/mcp
```

## CLI

The package ships a `nova-mcp` stdio MCP server. Clients spawn it as a
subprocess and speak JSON-RPC over stdin/stdout:

```sh
nova-mcp
```

Configuration is read from `~/.llamactl/nova-mcp.yaml` (override with
`$NOVA_MCP_CONFIG`). Missing config is fine — the facade still serves
its native `nova.*` tools.

## Library

```ts
import { buildNovaMcpServer } from "@novaproto/mcp";
```

Depends on [`@novaproto/contracts`](https://www.npmjs.com/package/@novaproto/contracts)
and [`@novaproto/mcp-shared`](https://www.npmjs.com/package/@novaproto/mcp-shared).

## License

MIT
