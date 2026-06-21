/**
 * MCP server for elastic-search-policy-control-plane.
 *
 * Exposes the planner / explain / policy-reload core as MCP tools that any MCP
 * client (Claude Code, Cursor, a custom agent) can call over stdio:
 *
 *   - `plan`            — build a deterministic execution plan (read-only).
 *   - `explain`         — return the explain projection of a plan (read-only).
 *   - `reload_policies` — MUTATING; reload policy JSON from disk. Gated behind
 *                         the `MCP_ALLOW_MUTATIONS` env var (default false).
 *
 * The tool *logic* lives in `src/mcp/tools.ts` as plain functions; the wrappers
 * here only supply the real dependencies (the live policy set, `createPlan`,
 * `explainPlan`, `loadPolicies`) and serialise the structured result. No
 * business logic lives in this layer.
 *
 * Run it with:  npm run mcp     (→ tsx src/mcp/server.ts)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPlan, explainPlan } from "../planner.js";
import { loadPolicies } from "../policies.js";
import type { Policy } from "../types.js";
import { type ToolResult } from "./errors.js";
import {
  explainTool,
  planTool,
  queryInputShape,
  reloadInputShape,
  reloadPoliciesTool
} from "./tools.js";

/** `MCP_ALLOW_MUTATIONS` is opt-in: only the literal string "true" enables mutations. */
function mutationsAllowed(): boolean {
  return process.env.MCP_ALLOW_MUTATIONS === "true";
}

/**
 * Serialise a structured tool result into the MCP content envelope. The full
 * structured payload (success or error) is returned as pretty JSON text, and the
 * MCP-level `isError` flag mirrors our contract so transport-aware clients can
 * branch without parsing the body.
 */
function toMcpContent(result: ToolResult<unknown>): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: result.isError
  };
}

export async function buildMcpServer(): Promise<McpServer> {
  // Live, in-memory policy set shared by all read-only tools; `reload_policies`
  // swaps it in place via `applyPolicies` so subsequent plans see the new set.
  let policies: Policy[] = await loadPolicies();
  const applyPolicies = (next: Policy[]): void => {
    policies = next;
  };

  const server = new McpServer({
    name: "policy-control-plane",
    version: "0.1.0"
  });

  server.registerTool(
    "plan",
    {
      title: "Plan a governed search query",
      description:
        "Build a deterministic, inspectable execution plan from raw user search text " +
        "(e.g. 'cheap chocolate without peanuts'). Read-only: applies the loaded policies " +
        "in priority order into rewritten_query, filters, boosts, exclusions, " +
        "retrieval_strategy, matched_policies, an explanation payload, and a generated " +
        "Elasticsearch function_score query body. Every clause carries its source_policy_id " +
        "and the explanation includes the policy_trace and conflict_trace. Does NOT query " +
        "Elasticsearch. On bad input returns a structured validation error.",
      inputSchema: queryInputShape
    },
    async (args) => toMcpContent(await planTool(args, { policies, createPlan }))
  );

  server.registerTool(
    "explain",
    {
      title: "Explain a governed search query",
      description:
        "Return the explain projection of the execution plan for a query (read-only): the " +
        "original query, rewritten_query, retrieval_strategy, matched_policies, the full " +
        "explanation (normalized query, consumed phrases, policy_trace, conflict_trace), and " +
        "the generated Elasticsearch query body — without search hits. Use this to audit WHY " +
        "the control plane would shape a query the way it does. On bad input returns a " +
        "structured validation error.",
      inputSchema: queryInputShape
    },
    async (args) =>
      toMcpContent(await explainTool(args, { policies, createPlan, explainPlan }))
  );

  server.registerTool(
    "reload_policies",
    {
      title: "Reload policies from disk (mutating, gated)",
      description:
        "MUTATING. Re-read policies/sample-policies.json from disk and swap the live policy " +
        "set used by `plan` and `explain`. This tool is gated behind the MCP_ALLOW_MUTATIONS " +
        "environment variable (default false): when mutations are disabled it performs NO " +
        "change and returns a structured business error (errorCategory='business', " +
        "isRetryable=false); set MCP_ALLOW_MUTATIONS=true to actually reload. On success " +
        "returns { status: 'reloaded', policies_loaded }.",
      inputSchema: reloadInputShape
    },
    async () =>
      toMcpContent(
        await reloadPoliciesTool(
          { loadPolicies, applyPolicies },
          { allowMutations: mutationsAllowed() }
        )
      )
  );

  return server;
}

async function main(): Promise<void> {
  const server = await buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics go to stderr; stdout is reserved for the MCP transport.
  console.error(
    `policy-control-plane MCP server ready on stdio (mutations ${
      mutationsAllowed() ? "ENABLED" : "disabled"
    }).`
  );
}

main().catch((error) => {
  console.error("Fatal error starting policy-control-plane MCP server:", error);
  process.exit(1);
});
