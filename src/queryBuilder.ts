import type { ExecutionPlan, FilterClause, ExclusionClause, BoostClause } from "./types.js";

function filterToEs(filter: FilterClause): Record<string, unknown> {
  if (filter.operator === "eq") {
    return { term: { [filter.field]: filter.value } };
  }

  if (filter.operator === "contains") {
    return { term: { [filter.field]: filter.value } };
  }

  return { range: { [filter.field]: { [filter.operator]: filter.value } } };
}

function exclusionToEs(exclusion: ExclusionClause): Record<string, unknown> {
  return { term: { [exclusion.field]: exclusion.value } };
}

function boostToEs(boost: BoostClause): Record<string, unknown> {
  return {
    filter: { term: { [boost.field]: boost.value } },
    weight: boost.weight
  };
}

export function buildElasticsearchQuery(plan: Omit<ExecutionPlan, "elasticsearch_query">): Record<string, unknown> {
  const baseQuery =
    plan.retrieval_strategy === "semantic_stub"
      ? {
          match: {
            semantic_text_stub: {
              query: plan.rewritten_query,
              boost: 0.1
            }
          }
        }
      : plan.rewritten_query.length === 0
        ? { match_all: {} }
      : {
          multi_match: {
            query: plan.rewritten_query,
            fields: ["name^3", "description", "category", "brand"],
            operator: "and"
          }
        };

  const should =
    plan.retrieval_strategy === "hybrid_stub"
      ? [
          baseQuery,
          {
            match: {
              semantic_text_stub: {
                query: plan.rewritten_query || plan.explanation.original_query,
                boost: 0.1
              }
            }
          }
        ]
      : undefined;

  return {
    index: "products",
    query: {
      function_score: {
        query: {
          bool: {
            must: should ? [{ bool: { should, minimum_should_match: 1 } }] : [baseQuery],
            filter: plan.filters.map(filterToEs),
            must_not: plan.exclusions.map(exclusionToEs)
          }
        },
        functions: plan.boosts.map(boostToEs),
        score_mode: "sum",
        boost_mode: "multiply"
      }
    }
  };
}
