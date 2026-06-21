/**
 * MCP tool handlers wrapping the planner / explain / policy-reload core.
 *
 * These are plain, importable async functions — no MCP server or transport
 * coupling — so they can be unit-tested directly with fake dependencies (a fake
 * `createPlan` / `loadPolicies`), without a live Elasticsearch cluster.
 * `src/mcp/server.ts` registers thin SDK wrappers that supply the real deps.
 *
 * Each handler runs inside `guard`, so it either returns a structured success
 * payload (`{ isError: false, result }`) or a structured error payload
 * (`{ isError: true, errorCategory, isRetryable, message, details }`) — never a
 * raised exception or a stack trace. The wrapped `result` is the *exact* same
 * object the corresponding Fastify route returns (full execution plan, explain
 * projection, or reload status), so provenance — `source_policy_id` on every
 * clause plus the `policy_trace` / `conflict_trace` — is always preserved.
 */

import { z } from "zod";
import { planRequestSchema, type ExecutionPlan, type ExplainResult, type Policy } from "../types.js";
import {
  ToolBusinessError,
  ToolValidationError,
  guard,
  successResult,
  type ToolResult
} from "./errors.js";

/** Reload status payload, mirroring the `POST /policies/reload` route response. */
export type ReloadResult = {
  status: "reloaded";
  policies_loaded: number;
};

/**
 * Dependencies the read-only tools need. `policies` is the live in-memory policy
 * set (the same array the Fastify app keeps), and `createPlan` is the pure
 * planner. Passing them explicitly keeps the tools testable and free of any ES
 * coupling — the planner itself never touches the network.
 */
export type PlanDeps = {
  policies: Policy[];
  createPlan: (query: string, policies: Policy[]) => ExecutionPlan;
};

export type ExplainDeps = PlanDeps & {
  explainPlan: (query: string, plan: ExecutionPlan) => ExplainResult;
};

/**
 * Dependencies for the mutating reload tool. `loadPolicies` re-reads the policy
 * JSON from disk; `applyPolicies` lets the caller swap the live policy set in
 * place (so the read-only tools see the reloaded policies afterwards).
 */
export type ReloadDeps = {
  loadPolicies: () => Promise<Policy[]>;
  applyPolicies: (policies: Policy[]) => void;
};

/** Validate the shared `{ query }` input using the repo's existing Zod schema. */
function parseQuery(input: unknown): string {
  const parsed = planRequestSchema.safeParse(input);

  if (!parsed.success) {
    throw new ToolValidationError("`query` must be a non-empty string.", {
      issues: parsed.error.flatten()
    });
  }

  return parsed.data.query;
}

/**
 * `plan` tool — build a deterministic execution plan for a query (read-only).
 * Returns the full `ExecutionPlan`, identical to `POST /plan`.
 */
export async function planTool(
  input: unknown,
  deps: PlanDeps
): Promise<ToolResult<ExecutionPlan>> {
  return guard("plan", async () => {
    const query = parseQuery(input);
    const plan = deps.createPlan(query, deps.policies);
    return successResult(plan);
  });
}

/**
 * `explain` tool — return the explain projection for a query (read-only).
 * Returns the same shape as `POST /explain`.
 */
export async function explainTool(
  input: unknown,
  deps: ExplainDeps
): Promise<ToolResult<ExplainResult>> {
  return guard("explain", async () => {
    const query = parseQuery(input);
    const plan = deps.createPlan(query, deps.policies);
    return successResult(deps.explainPlan(query, plan));
  });
}

/**
 * `reload_policies` tool — MUTATING. Re-reads `policies/sample-policies.json`
 * from disk and swaps the live policy set in place.
 *
 * Gated behind `MCP_ALLOW_MUTATIONS`: when `allowMutations` is false (the
 * default), the tool performs no mutation and returns a structured *business*
 * error instead. When true, it reloads and returns `{ status, policies_loaded }`,
 * identical to `POST /policies/reload`.
 */
export async function reloadPoliciesTool(
  deps: ReloadDeps,
  options: { allowMutations: boolean }
): Promise<ToolResult<ReloadResult>> {
  return guard("reload_policies", async () => {
    if (!options.allowMutations) {
      throw new ToolBusinessError(
        "Mutations are disabled. Set MCP_ALLOW_MUTATIONS=true to allow reload_policies.",
        { tool: "reload_policies", allowMutations: false }
      );
    }

    const policies = await deps.loadPolicies();
    deps.applyPolicies(policies);

    return successResult({ status: "reloaded", policies_loaded: policies.length });
  });
}

/** Zod raw shape for the `{ query }` input, shared by the `plan`/`explain` tools. */
export const queryInputShape = {
  query: z.string().min(1).describe("Raw user search text to plan/explain.")
} as const;

/** `reload_policies` takes no input. */
export const reloadInputShape = {} as const;
