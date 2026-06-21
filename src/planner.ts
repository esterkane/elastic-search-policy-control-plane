import { buildElasticsearchQuery } from "./queryBuilder.js";
import { sortPolicies } from "./policies.js";
import type {
  BoostClause,
  ExecutionPlan,
  ExclusionClause,
  ExplainResult,
  FilterClause,
  MatchedPolicy,
  Policy,
  PolicyAction,
  RetrievalStrategy
} from "./types.js";

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function phraseMatches(query: string, phrase?: string): boolean {
  return phrase ? query.includes(normalizeQuery(phrase)) : true;
}

function termsMatch(query: string, terms: string[]): boolean {
  return terms.length === 0 || terms.every((term) => query.includes(normalizeQuery(term)));
}

function regexMatches(query: string, regex?: string): boolean {
  if (!regex) {
    return true;
  }

  return new RegExp(regex, "i").test(query);
}

function getConsumedPhrase(query: string, action: PolicyAction, phrase?: string): string[] {
  if (action.type === "remove_phrase") {
    return [normalizeQuery(action.phrase)];
  }

  if (phrase && phraseMatches(query, phrase)) {
    return [normalizeQuery(phrase)];
  }

  return [];
}

function removeConsumedPhrases(query: string, consumedPhrases: string[]): string {
  return consumedPhrases
    .reduce((current, phrase) => current.replaceAll(phrase, " "), query)
    .replace(/\s+/g, " ")
    .trim();
}

function sameFilterTarget(a: FilterClause, b: FilterClause): boolean {
  return a.field === b.field && a.operator === b.operator;
}

function sameExclusionTarget(a: ExclusionClause, b: ExclusionClause): boolean {
  return a.field === b.field && a.value === b.value;
}

function sameBoostTarget(a: BoostClause, b: BoostClause): boolean {
  return a.field === b.field && a.value === b.value;
}

export function createPlan(query: string, policies: Policy[]): ExecutionPlan {
  const normalizedQuery = normalizeQuery(query);
  const orderedPolicies = sortPolicies(policies);
  const filters: FilterClause[] = [];
  const boosts: BoostClause[] = [];
  const exclusions: ExclusionClause[] = [];
  const matchedPolicies: MatchedPolicy[] = [];
  const consumedPhrases = new Set<string>();
  const conflictTrace: string[] = [];
  let retrievalStrategy: RetrievalStrategy = "lexical";

  for (const policy of orderedPolicies) {
    const isMatch =
      phraseMatches(normalizedQuery, policy.match.phrase) &&
      termsMatch(normalizedQuery, policy.match.terms) &&
      regexMatches(normalizedQuery, policy.match.regex);

    if (!isMatch) {
      continue;
    }

    const policyConsumedPhrases = getConsumedPhrase(normalizedQuery, policy.action, policy.match.phrase);
    for (const phrase of policyConsumedPhrases) {
      consumedPhrases.add(phrase);
    }

    if (policy.action.type === "add_filter") {
      const incoming: FilterClause = {
        field: policy.action.field,
        operator: policy.action.operator,
        value: policy.action.value,
        source_policy_id: policy.id
      };
      const existingIndex = filters.findIndex((filter) => sameFilterTarget(filter, incoming));

      if (existingIndex === -1) {
        filters.push(incoming);
      } else if (policy.conflict_strategy === "override") {
        conflictTrace.push(`${policy.id} replaced filter from ${filters[existingIndex].source_policy_id}`);
        filters[existingIndex] = incoming;
      } else if (policy.conflict_strategy === "restrict") {
        const existing = filters[existingIndex];
        if (incoming.operator === "lte" && Number(incoming.value) < Number(existing.value)) {
          filters[existingIndex] = incoming;
          conflictTrace.push(`${policy.id} tightened ${incoming.field} upper bound`);
        } else if (incoming.operator === "gte" && Number(incoming.value) > Number(existing.value)) {
          filters[existingIndex] = incoming;
          conflictTrace.push(`${policy.id} tightened ${incoming.field} lower bound`);
        } else {
          conflictTrace.push(`${policy.id} kept stricter existing filter from ${existing.source_policy_id}`);
        }
      } else {
        conflictTrace.push(`${policy.id} did not replace existing hard filter`);
      }
    }

    if (policy.action.type === "add_exclusion") {
      const incoming: ExclusionClause = {
        field: policy.action.field,
        value: policy.action.value,
        source_policy_id: policy.id
      };

      if (!exclusions.some((exclusion) => sameExclusionTarget(exclusion, incoming))) {
        exclusions.push(incoming);
      }
    }

    if (policy.action.type === "add_boost") {
      const incoming: BoostClause = {
        field: policy.action.field,
        value: policy.action.value,
        weight: policy.action.weight,
        source_policy_id: policy.id
      };
      const conflictsWithExclusion = exclusions.some(
        (exclusion) => exclusion.field === incoming.field && exclusion.value === incoming.value
      );

      if (conflictsWithExclusion) {
        conflictTrace.push(`${policy.id} boost skipped because an exclusion already blocks ${incoming.field}:${incoming.value}`);
      } else if (!boosts.some((boost) => sameBoostTarget(boost, incoming))) {
        boosts.push(incoming);
      }
    }

    if (policy.action.type === "set_retrieval_strategy") {
      if (retrievalStrategy !== policy.action.strategy && retrievalStrategy !== "lexical") {
        conflictTrace.push(`${policy.id} changed retrieval strategy from ${retrievalStrategy} to ${policy.action.strategy}`);
      }
      retrievalStrategy = policy.action.strategy;
    }

    matchedPolicies.push({
      id: policy.id,
      name: policy.name,
      priority: policy.priority,
      action: policy.action.type,
      conflict_strategy: policy.conflict_strategy,
      consumed_phrases: policyConsumedPhrases,
      explanation: policy.explanation
    });
  }

  const rewrittenQuery = removeConsumedPhrases(normalizedQuery, [...consumedPhrases]);
  const planWithoutQuery = {
    rewritten_query: rewrittenQuery,
    filters,
    boosts,
    exclusions,
    retrieval_strategy: retrievalStrategy,
    matched_policies: matchedPolicies,
    explanation: {
      original_query: query,
      normalized_query: normalizedQuery,
      consumed_phrases: [...consumedPhrases].sort(),
      policy_trace: matchedPolicies,
      conflict_trace: conflictTrace
    }
  };

  return {
    ...planWithoutQuery,
    elasticsearch_query: buildElasticsearchQuery(planWithoutQuery)
  };
}

/**
 * Project a full execution plan into the explain payload shape returned by the
 * `POST /explain` route. Kept here (next to `createPlan`) so the Fastify route
 * and the MCP `explain` tool return the exact same object without duplicating
 * the projection.
 */
export function explainPlan(query: string, plan: ExecutionPlan): ExplainResult {
  return {
    query,
    rewritten_query: plan.rewritten_query,
    retrieval_strategy: plan.retrieval_strategy,
    matched_policies: plan.matched_policies,
    explanation: plan.explanation,
    elasticsearch_query: plan.elasticsearch_query
  };
}
