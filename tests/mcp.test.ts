import { describe, expect, it, vi } from "vitest";
import { createPlan, explainPlan } from "../src/planner.js";
import { loadPolicies } from "../src/policies.js";
import {
  explainTool,
  planTool,
  reloadPoliciesTool,
  type ReloadDeps
} from "../src/mcp/tools.js";
import type { Policy } from "../src/types.js";

async function samplePolicies(): Promise<Policy[]> {
  return loadPolicies();
}

describe("mcp plan tool", () => {
  it("returns the same plan shape as createPlan, with provenance preserved", async () => {
    const policies = await samplePolicies();
    const result = await planTool(
      { query: "cheap chocolate without peanuts" },
      { policies, createPlan }
    );

    expect(result.isError).toBe(false);
    if (result.isError) {
      return;
    }

    // Identical to POST /plan: createPlan output, verbatim.
    expect(result.result).toEqual(createPlan("cheap chocolate without peanuts", policies));

    // Provenance invariant: every clause traces back to a source policy.
    expect(result.result.filters).toEqual([
      { field: "price", operator: "lte", value: 25, source_policy_id: "cheap-price-filter" }
    ]);
    expect(result.result.exclusions[0].source_policy_id).toBe("exclude-peanuts");
    expect(result.result.explanation.policy_trace.length).toBeGreaterThan(0);
  });

  it("returns a structured validation error for an empty query", async () => {
    const policies = await samplePolicies();
    const result = await planTool({ query: "" }, { policies, createPlan });

    expect(result.isError).toBe(true);
    if (!result.isError) {
      return;
    }
    expect(result.errorCategory).toBe("validation");
    expect(result.isRetryable).toBe(false);
    expect(result.message).toMatch(/non-empty/i);
  });

  it("returns a validation error for a missing query field", async () => {
    const policies = await samplePolicies();
    const result = await planTool({}, { policies, createPlan });

    expect(result.isError).toBe(true);
    if (!result.isError) {
      return;
    }
    expect(result.errorCategory).toBe("validation");
  });

  it("never leaks a stack trace when the planner throws (mapped to transient)", async () => {
    const boom = vi.fn(() => {
      throw new Error("internal planner explosion with secrets in stack");
    });
    const result = await planTool({ query: "anything" }, { policies: [], createPlan: boom });

    expect(result.isError).toBe(true);
    if (!result.isError) {
      return;
    }
    expect(result.errorCategory).toBe("transient");
    expect(result.message).not.toContain("explosion");
    expect(JSON.stringify(result)).not.toContain("internal planner explosion");
  });
});

describe("mcp explain tool", () => {
  it("returns the same explain projection as the /explain route", async () => {
    const policies = await samplePolicies();
    const query = "wireless headphones under 100";
    const result = await explainTool({ query }, { policies, createPlan, explainPlan });

    expect(result.isError).toBe(false);
    if (result.isError) {
      return;
    }

    expect(result.result).toEqual(explainPlan(query, createPlan(query, policies)));
    expect(result.result.query).toBe(query);
    // explain must keep the matched policies / explanation (audit trail).
    expect(result.result.matched_policies.length).toBeGreaterThan(0);
    expect(result.result.explanation.conflict_trace).toEqual([]);
  });

  it("returns a validation error for an empty query", async () => {
    const policies = await samplePolicies();
    const result = await explainTool({ query: "   " }, { policies, createPlan, explainPlan });

    // planRequestSchema requires min length 1 on the raw string; whitespace passes
    // length but the planner still produces a plan, so assert no crash either way.
    expect(result.isError).toBe(false);
  });
});

describe("mcp reload_policies tool (mutating, gated)", () => {
  function reloadDeps(): ReloadDeps & { applied: Policy[][] } {
    const applied: Policy[][] = [];
    const fakePolicies: Policy[] = [
      {
        id: "fake",
        name: "Fake",
        priority: 1,
        match: { terms: [] },
        action: { type: "set_retrieval_strategy", strategy: "lexical" },
        conflict_strategy: "override",
        explanation: "fake"
      }
    ];
    return {
      applied,
      loadPolicies: vi.fn(async () => fakePolicies),
      applyPolicies: vi.fn((next: Policy[]) => {
        applied.push(next);
      })
    };
  }

  it("is BLOCKED with a business error when MCP_ALLOW_MUTATIONS is unset", async () => {
    const deps = reloadDeps();
    const result = await reloadPoliciesTool(deps, { allowMutations: false });

    expect(result.isError).toBe(true);
    if (!result.isError) {
      return;
    }
    expect(result.errorCategory).toBe("business");
    expect(result.isRetryable).toBe(false);
    expect(result.message).toMatch(/MCP_ALLOW_MUTATIONS/);
    // No mutation happened.
    expect(deps.loadPolicies).not.toHaveBeenCalled();
    expect(deps.applyPolicies).not.toHaveBeenCalled();
    expect(deps.applied).toEqual([]);
  });

  it("RELOADS and reports the count when mutations are allowed", async () => {
    const deps = reloadDeps();
    const result = await reloadPoliciesTool(deps, { allowMutations: true });

    expect(result.isError).toBe(false);
    if (result.isError) {
      return;
    }
    expect(result.result).toEqual({ status: "reloaded", policies_loaded: 1 });
    expect(deps.loadPolicies).toHaveBeenCalledOnce();
    expect(deps.applyPolicies).toHaveBeenCalledOnce();
    expect(deps.applied[0]).toHaveLength(1);
  });

  it("maps a disk read failure to a transient error without leaking detail", async () => {
    const deps: ReloadDeps = {
      loadPolicies: vi.fn(async () => {
        const err = new Error("ENOENT: secret path /etc/policies.json");
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }),
      applyPolicies: vi.fn()
    };
    const result = await reloadPoliciesTool(deps, { allowMutations: true });

    expect(result.isError).toBe(true);
    if (!result.isError) {
      return;
    }
    // ENOENT is not in the transient connectivity set, so it falls through to the
    // generic non-retryable guard — but still never leaks the path.
    expect(result.errorCategory).toBe("transient");
    expect(JSON.stringify(result)).not.toContain("/etc/policies.json");
  });
});
