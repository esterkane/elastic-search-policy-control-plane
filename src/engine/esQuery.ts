import { ExecutionPlan, FilterSpec } from "./types.js";

function filterClause(filter: FilterSpec): Record<string, unknown> {
  if (filter.operator === "eq") {
    return { term: { [filter.field]: filter.value } };
  }

  if (filter.operator === "in") {
    return { terms: { [filter.field]: filter.value } };
  }

  return { range: { [filter.field]: { [filter.operator]: filter.value } } };
}

export function buildElasticsearchQuery(plan: Omit<ExecutionPlan, "elasticsearch_query">): Record<string, unknown> {
  const filter = plan.filters.map(filterClause);
  const must_not = plan.exclusions.map((exclusion) => ({
    term: { [exclusion.field]: exclusion.value }
  }));
  const should = plan.boosts.map((boost) => ({
    constant_score: {
      filter: { term: { [boost.field]: boost.value } },
      boost: boost.weight
    }
  }));

  const textQuery =
    plan.retrieval_strategy === "lexical"
      ? { match: { name: { query: plan.rewritten_query || plan.original_query, operator: "and" } } }
      : {
          multi_match: {
            query: plan.rewritten_query || plan.original_query,
            fields: ["name^2", "description", "category"],
            type: "best_fields"
          }
        };

  return {
    index: "products",
    query: {
      bool: {
        must: [textQuery],
        filter,
        must_not,
        should,
        minimum_should_match: 0
      }
    },
    _source: ["id", "name", "category", "price", "allergens", "tags"]
  };
}
