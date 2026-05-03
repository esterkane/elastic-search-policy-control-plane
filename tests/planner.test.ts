import { describe, expect, it } from "vitest";
import { createPlan } from "../src/planner.js";
import { loadPolicies } from "../src/policies.js";
import type { Policy } from "../src/types.js";

describe("policy planner", () => {
  it("composes multiple matching policies deterministically", async () => {
    const policies = await loadPolicies();
    const plan = createPlan("cheap chocolate without peanuts", policies);

    expect(plan.rewritten_query).toBe("chocolate");
    expect(plan.filters).toEqual([
      {
        field: "price",
        operator: "lte",
        value: 25,
        source_policy_id: "cheap-price-filter"
      }
    ]);
    expect(plan.exclusions).toEqual([
      {
        field: "allergens",
        value: "peanuts",
        source_policy_id: "exclude-peanuts"
      }
    ]);
    expect(plan.boosts).toEqual([
      {
        field: "price_band",
        value: "budget",
        weight: 1.4,
        source_policy_id: "cheap-price-boost"
      }
    ]);
    expect(plan.matched_policies.map((policy) => policy.id)).toEqual([
      "exclude-peanuts",
      "cheap-price-filter",
      "cheap-price-boost",
      "remove-cheap-phrase",
      "remove-without-peanuts-phrase"
    ]);
  });

  it("lets higher-priority explicit price policy win over lower-priority cheap hint", async () => {
    const policies = await loadPolicies();
    const plan = createPlan("cheap wireless headphones under 100", policies);

    expect(plan.filters).toEqual([
      {
        field: "price",
        operator: "lte",
        value: 100,
        source_policy_id: "price-under-100"
      },
      {
        field: "category",
        operator: "eq",
        value: "electronics/audio",
        source_policy_id: "wireless-headphones-category"
      }
    ]);
    expect(plan.explanation.conflict_trace).toContain("cheap-price-filter did not replace existing hard filter");
  });

  it("keeps exclusions when a later boost targets the same field and value", () => {
    const policies: Policy[] = [
      {
        id: "exclude-clearance",
        name: "Exclude clearance",
        priority: 20,
        match: { phrase: "no clearance", terms: ["clearance"] },
        action: { type: "add_exclusion", field: "tags", value: "clearance" },
        conflict_strategy: "restrict",
        explanation: "Clearance products are excluded."
      },
      {
        id: "boost-clearance",
        name: "Boost clearance",
        priority: 10,
        match: { phrase: "clearance", terms: ["clearance"] },
        action: { type: "add_boost", field: "tags", value: "clearance", weight: 2 },
        conflict_strategy: "soft_boost",
        explanation: "Clearance products would normally be boosted."
      }
    ];

    const plan = createPlan("speaker no clearance", policies);

    expect(plan.exclusions).toEqual([{ field: "tags", value: "clearance", source_policy_id: "exclude-clearance" }]);
    expect(plan.boosts).toEqual([]);
    expect(plan.explanation.conflict_trace).toEqual([
      "boost-clearance boost skipped because an exclusion already blocks tags:clearance"
    ]);
  });

  it("routes broad gift intent to the semantic strategy stub", async () => {
    const policies = await loadPolicies();
    const plan = createPlan("gift for grandpa", policies);

    expect(plan.retrieval_strategy).toBe("semantic_stub");
    expect(plan.rewritten_query).toBe("");
    expect(plan.elasticsearch_query).toMatchObject({
      query: {
        function_score: {
          query: {
            bool: {
              must: [
                {
                  match: {
                    semantic_text_stub: {
                      query: ""
                    }
                  }
                }
              ]
            }
          }
        }
      }
    });
  });

  it("returns a stable explain payload", async () => {
    const policies = await loadPolicies();
    const plan = createPlan("wireless headphones under 100", policies);

    expect(plan.explanation).toEqual({
      original_query: "wireless headphones under 100",
      normalized_query: "wireless headphones under 100",
      consumed_phrases: ["under 100", "wireless headphones"],
      policy_trace: [
        {
          id: "price-under-100",
          name: "Apply under 100 price ceiling",
          priority: 90,
          action: "add_filter",
          conflict_strategy: "override",
          consumed_phrases: ["under 100"],
          explanation: "The query includes an explicit price ceiling, which takes precedence over softer price hints."
        },
        {
          id: "remove-under-100-phrase",
          name: "Consume under 100 phrase",
          priority: 71,
          action: "remove_phrase",
          conflict_strategy: "restrict",
          consumed_phrases: ["under 100"],
          explanation: "The explicit price phrase is consumed after becoming a price filter."
        },
        {
          id: "wireless-headphones-category",
          name: "Constrain wireless headphones to audio electronics",
          priority: 70,
          action: "add_filter",
          conflict_strategy: "restrict",
          consumed_phrases: ["wireless headphones"],
          explanation: "Wireless headphone queries should stay in the audio electronics category."
        },
        {
          id: "remove-wireless-headphones-phrase",
          name: "Consume wireless headphones phrase",
          priority: 69,
          action: "remove_phrase",
          conflict_strategy: "restrict",
          consumed_phrases: ["wireless headphones"],
          explanation: "The controlled phrase is consumed after it has been converted into a category filter."
        }
      ],
      conflict_trace: []
    });
  });
});
