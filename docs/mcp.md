# Agent Access via MCP

This repo ships an **MCP (Model Context Protocol) server** that exposes the
planner / explain core as agent tools, so an MCP client (Claude Code, Cursor, or
a custom agent) can build and audit governed search plans without going through
the HTTP API.

The server is a **thin adapter**: all tool logic lives in
[`src/mcp/tools.ts`](../src/mcp/tools.ts) as pure functions that take explicit
dependencies (the live policy set, `createPlan`, `explainPlan`, `loadPolicies`).
[`src/mcp/server.ts`](../src/mcp/server.ts) only wires those functions to the
official [TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(`@modelcontextprotocol/sdk`) and serialises the result. No business logic lives
in the MCP layer — the tools return the **exact same objects** the Fastify routes
return, so `source_policy_id` on every clause and the `policy_trace` /
`conflict_trace` provenance are always preserved.

## Running the server

The server speaks the **stdio** transport (the default for local dev and Claude
Code) and reads its policies from `policies/sample-policies.json` on startup.

```bash
npm run mcp          # → tsx src/mcp/server.ts
# or directly:
tsx src/mcp/server.ts
```

It does **not** need a running Elasticsearch cluster: `plan` and `explain` are
pure planner operations, and `reload_policies` only reads local JSON. Diagnostics
go to **stderr**; stdout is reserved for the MCP JSON-RPC transport.

### Mutation gate — `MCP_ALLOW_MUTATIONS`

`reload_policies` is the only mutating tool, and it is gated behind the
`MCP_ALLOW_MUTATIONS` environment variable:

| `MCP_ALLOW_MUTATIONS` | `reload_policies` behavior |
|---|---|
| unset / anything but `"true"` (**default**) | No mutation. Returns a structured **business** error. |
| `"true"` | Reloads the policy JSON and swaps the live policy set in place. |

```bash
# read-only (default): reload_policies returns a business error
npm run mcp

# allow reloads
MCP_ALLOW_MUTATIONS=true npm run mcp
```

No other mutating capability is exposed over MCP.

## Tools

| Tool | Kind | Wraps | Returns |
|---|---|---|---|
| `plan` | read-only | `createPlan(query, policies)` | full `ExecutionPlan` (same as `POST /plan`) |
| `explain` | read-only | `createPlan` + `explainPlan` | explain projection (same as `POST /explain`) |
| `reload_policies` | **mutating, gated** | `loadPolicies()` | `{ status, policies_loaded }` (same as `POST /policies/reload`) |

### `plan(query)`

Builds a deterministic, inspectable execution plan from raw user search text.
Read-only; never queries Elasticsearch.

Input: `{ "query": "<non-empty string>" }`

Success result is the full `ExecutionPlan`: `rewritten_query`, `filters`,
`boosts`, `exclusions`, `retrieval_strategy`, `matched_policies`, `explanation`
(with `policy_trace` and `conflict_trace`), and the generated Elasticsearch
`function_score` query body. Every filter/boost/exclusion carries its
`source_policy_id`.

### `explain(query)`

Returns the explain projection: `query`, `rewritten_query`,
`retrieval_strategy`, `matched_policies`, the full `explanation`, and the
generated Elasticsearch query body — without search hits. Use it to audit **why**
the control plane shapes a query the way it does.

Input: `{ "query": "<non-empty string>" }`

### `reload_policies()`

**Mutating.** Re-reads `policies/sample-policies.json` from disk and swaps the
live policy set used by `plan` and `explain`. Gated behind `MCP_ALLOW_MUTATIONS`
(see above). Takes no input.

## Error contract

Every tool returns a structured result — never a raised exception or a stack
trace. The wire payload is JSON text inside the MCP content block, and the
MCP-level `isError` flag mirrors the contract.

Success:

```json
{ "isError": false, "result": { /* the domain payload */ } }
```

Error:

```json
{
  "isError": true,
  "errorCategory": "validation" | "transient" | "business",
  "isRetryable": false,
  "message": "<safe, human-readable summary>",
  "details": { }
}
```

| `errorCategory` | When | `isRetryable` |
|---|---|---|
| `validation` | Bad input (empty / missing `query`). | `false` |
| `business` | Valid request refused by policy/config (mutations disabled). | `false` |
| `transient` | A backend dependency was momentarily unreachable, or an unexpected internal error (logged to stderr only). | `true` for connectivity, `false` for the generic last-resort guard |

Stack traces and internal paths are never returned to the caller.

## Example calls and outputs

`plan` for `cheap chocolate without peanuts` (abridged):

```json
{
  "isError": false,
  "result": {
    "rewritten_query": "chocolate",
    "filters": [
      { "field": "price", "operator": "lte", "value": 25, "source_policy_id": "cheap-price-filter" }
    ],
    "exclusions": [
      { "field": "allergens", "value": "peanuts", "source_policy_id": "exclude-peanuts" }
    ],
    "retrieval_strategy": "lexical",
    "matched_policies": [ /* ... with consumed_phrases + explanation ... */ ],
    "explanation": { "policy_trace": [ /* ... */ ], "conflict_trace": [] },
    "elasticsearch_query": { /* function_score body */ }
  }
}
```

`reload_policies` with `MCP_ALLOW_MUTATIONS` **unset** (gated):

```json
{
  "isError": true,
  "errorCategory": "business",
  "isRetryable": false,
  "message": "Mutations are disabled. Set MCP_ALLOW_MUTATIONS=true to allow reload_policies.",
  "details": { "tool": "reload_policies", "allowMutations": false }
}
```

`reload_policies` with `MCP_ALLOW_MUTATIONS=true`:

```json
{ "isError": false, "result": { "status": "reloaded", "policies_loaded": 11 } }
```

## Client registration

Register the server with any MCP client by running it via `tsx`. Example
`mcpServers` entry (Claude Code / Cursor style):

```json
{
  "mcpServers": {
    "policy-control-plane": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/elastic-search-policy-control-plane",
      "env": {
        "MCP_ALLOW_MUTATIONS": "false"
      }
    }
  }
}
```

Set `MCP_ALLOW_MUTATIONS` to `"true"` only when you intend to let the agent
reload policies from disk.
