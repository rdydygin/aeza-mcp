<img src="assets/icon.svg" width="64" height="64" alt="">

# aeza-mcp

[MCP](https://modelcontextprotocol.io) server for the [Aeza API](https://my.aeza.ru/api/v2/docs): servers, backups, networks, DNS, billing and support as tools for an AI agent, one tool per API operation.

The tools are not baked in. On startup the server reads the API's OpenAPI spec and builds them from it, so it follows the API without a new release.

## Setup

The server speaks MCP over stdio and needs Node 20 or newer:

```sh
claude mcp add aeza -e AEZA_API_KEY=<key> -- npx -y aeza-mcp
```

For clients configured with JSON:

```json
{
  "mcpServers": {
    "aeza": {
      "command": "npx",
      "args": ["-y", "aeza-mcp"],
      "env": { "AEZA_API_KEY": "<key>", "AEZA_READ_ONLY": "1" }
    }
  }
}
```

With [Bun](https://bun.sh), `bunx aeza-mcp` does the same without Node.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `AEZA_API_KEY` | | API key of the account. Without it only public endpoints work |
| `AEZA_TOOLSETS` | everything but `internal` and `other` | Comma-separated toolsets to expose, or `all` |
| `AEZA_READ_ONLY` | off | `1` exposes only tools that change nothing |
| `AEZA_MAX_OUTPUT_CHARS` | `40000` | Longer results are cut, lists at an item boundary with a note on how many items are missing |
| `AEZA_BASE_URL` | `https://my.aeza.ru/api/v2` | |

## How the spec is kept current

The spec is cached in `~/.cache/aeza-mcp` (or `$XDG_CACHE_HOME/aeza-mcp`). Each start makes one small request, `GET /version`, and compares it with the cached spec's version; the 160 KB spec itself is downloaded only when they differ. A start takes about a second the first time and half a second after that.

- When the API cannot be reached, the cached spec is used. With no cache either, the server exits with an error.
- When the spec changes, the tools change with it, and the server says so on stderr (`API spec updated: 60644150 -> …`). Nobody reviews that change, so a new endpoint is callable as soon as Aeza documents it.
- Sections of the API this server has not seen before go to the `other` toolset, which is off by default, so a new kind of tool appears only when you opt in.
- An operation the server cannot make sense of is skipped with a line on stderr; the rest keep working.

## Toolsets

Counts are for the spec as of November 2026.

| Toolset | Tools | Read-only | Covers |
| --- | --- | --- | --- |
| `services` | 53 | 20 | Servers: power, reinstall, rescue, stats, prolongation, backups, IPs and PTR, SSH keys, extra resources |
| `catalog` | 8 | 7 | Products, groups and types; price calculation and ordering |
| `domains` | 15 | 8 | Domains and DNS records, availability and delegation checks |
| `billing` | 18 | 11 | Transactions, invoices, payment methods, recurrent payments, withdrawals |
| `account` | 28 | 8 | Profile, API keys, sessions, SSO links, companies, notifications |
| `support` | 19 | 9 | Tickets, messages, ratings, file uploads |
| `promo` | 16 | 9 | Referral program, gifts, bonuses, gift codes |
| `system` | 8 | 7 | Health, version, error catalog, alerts |
| `internal` | 19 | 7 | Plumbing of the web panel (login flows, websocket tokens, web push, consents); off by default |
| `other` | 0 | 0 | API sections added after this list was written; off by default |

The default set is 165 tools, about 72 KB of tool definitions. Clients that load every definition into the model's context up front do better with a narrower `AEZA_TOOLSETS`, for example `services,catalog,domains` (76 tools, 36 KB).

## Tools

A tool is named after its API section and operation: `services_get_list`, `domains_create_record`, `service_backups_restore`. Path and query parameters are top-level arguments, the request body goes under `body`:

```json
{ "name": "domains_create_record", "arguments": { "domainId": 1, "body": { "type": "A", "name": "www", "content": "192.0.2.1" } } }
```

Arguments are validated against the spec before anything is sent. API errors come back as tool errors with the API's status, error code and details. Rate-limited requests (the API allows 10 per second) are retried.

Tools that are not read-only act on the real account: orders and prolongations spend its balance, deleting or reinstalling a server destroys its data. They are annotated as destructive so clients can ask for confirmation; `AEZA_READ_ONLY=1` removes them entirely.

## Development

```sh
bun install
bun start           # run the server from source
bun run typecheck
bun test
bun publish         # typechecks, tests and builds dist/ first
```

| File | |
| --- | --- |
| `src/spec.ts` | Downloads and caches the spec |
| `src/operations.ts` | Turns the spec into tool definitions: names, toolsets, JSON Schemas, and fixes for what the spec gets wrong |
| `src/api.ts` | HTTP calls: API key, serialization, errors, retries |
| `src/server.ts` | The MCP server |
| `test/openapi.json` | Snapshot of the real spec that the tests run against |

Created in [T3 Code](https://t3.codes).
