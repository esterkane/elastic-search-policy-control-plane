import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionPlan } from "../src/engine/planner.js";
import { loadPolicies } from "../src/engine/policyStore.js";
import { Policy } from "../src/engine/types.js";

let policies: Policy[];

beforeAll(async () => {
  policies = await loadPolicies();
});

describe("policy planner", () => {
  it("composes multiple matching policies deterministically", () => {
    const plan = createExecutionPlan("cheap chocolate without peanuts", policies);

    expect(plan.rewritten_query).toBe("chocolate");
    expect(plan.filters).toEqual([
      {
        field: "price",
        operator: "lte",
        value: 50
      }
    ]);
    expect(plan.exclusions).toEqual([
      {
        field: "allergens",
        value: "peanuts"
      }
    ]);
    expect(plan.boosts).toEqual([
      {
        field: "tags",
        value: "budget",
        weight: 1.5
      }
    ]);
    expect(plan.matched_policies.map((policy) => policy.id)).toEqual([
      "p100-without-peanuts",
      "p60-cheap",
      "p10-peanut-snack-boost"
    ]);
  });

  it("lets the higher-priority explicit price policy win over a later soft price policy", () => {
    const plan = createExecutionPlan("cheap wireless headphones under 100", policies);

    expect(plan.filters).toContainEqual({
      field: "price",
      operator: "lte",
      value: 100
    });
    expect(plan.filters.filter((filter) => filter.field === "price")).toHaveLength(1);

    const cheapPolicy = plan.matched_policies.find((policy) => policy.id === "p60-cheap");
    expect(cheapPolicy?.conflict_notes).toContain("kept existing filter on price");
  });

  it("keeps exclusions authoritative over later boosts", () => {
    const plan = createExecutionPlan("cheap chocolate without peanuts", policies);

    expect(plan.exclusions).toContainEqual({
      field: "allergens",
      value: "peanuts"
    });
    expect(plan.boosts).not.toContainEqual({
      field: "allergens",
      value: "peanuts",
      weight: 3
    });

    const peanutBoost = plan.matched_policies.find((policy) => policy.id === "p10-peanut-snack-boost");
    expect(peanutBoost?.applied).toBe(false);
    expect(peanutBoost?.conflict_notes).toContain("boost ignored because allergens:peanuts is excluded");
  });

  it("routes broad gift intent to semantic_stub", () => {
    const plan = createExecutionPlan("gift for grandpa", policies);

    expect(plan.retrieval_strategy).toBe("semantic_stub");
    expect(plan.rewritten_query).toBe("");
    expect(plan.elasticsearch_query.query).toMatchObject({
      bool: {
        must: [
          {
            multi_match: {
              query: "gift for grandpa"
            }
          }
        ]
      }
    });
  });

  it("keeps the explain payload stable", () => {
    const plan = createExecutionPlan("wireless headphones under 100", policies);

    expect({
      rewritten_query: plan.rewritten_query,
      consumed_phrases: plan.consumed_phrases,
      matched_policy_ids: plan.matched_policies.map((policy) => policy.id),
      explanations: plan.explanation
    }).toEqual({
      rewritten_query: "",
      consumed_phrases: ["under 100", "wireless headphones"],
      matched_policy_ids: ["p90-under-100", "p70-wireless-headphones"],
      explanations: [
        "The phrase under 100 is interpreted as a hard maximum price filter.",
        "Wireless headphones are mapped to the electronics/audio category with a wireless tag boost."
      ]
    });
  });
});
