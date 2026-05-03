import { buildElasticsearchQuery } from "./esQuery.js";
import {
  BoostSpec,
  ExecutionPlan,
  ExclusionSpec,
  FilterSpec,
  MatchedPolicy,
  Policy,
  RetrievalStrategy
} from "./types.js";

type MutablePlan = {
  filters: FilterSpec[];
  boosts: BoostSpec[];
  exclusions: ExclusionSpec[];
  retrieval_strategy: RetrievalStrategy;
  consumed_phrases: string[];
  matched_policies: MatchedPolicy[];
  explanation: string[];
};

type MatchResult = {
  matched: boolean;
  matchedBy: string[];
  consumedPhrases: string[];
};

export function createExecutionPlan(query: string, policies: Policy[]): ExecutionPlan {
  const normalizedQuery = normalize(query);
  const mutable: MutablePlan = {
    filters: [],
    boosts: [],
    exclusions: [],
    retrieval_strategy: "lexical",
    consumed_phrases: [],
    matched_policies: [],
    explanation: []
  };

  for (const policy of policies) {
    const match = matchPolicy(normalizedQuery, policy);
    if (!match.matched) {
      continue;
    }

    const matchedPolicy: MatchedPolicy = {
      id: policy.id,
      name: policy.name,
      priority: policy.priority,
      conflict_strategy: policy.conflict_strategy,
      explanation: policy.explanation,
      matched_by: match.matchedBy,
      consumed_phrases: match.consumedPhrases,
      applied: true,
      conflict_notes: []
    };

    applyPolicy(mutable, policy, matchedPolicy);
    mutable.matched_policies.push(matchedPolicy);
  }

  const rewritten_query = rewriteQuery(normalizedQuery, mutable.consumed_phrases);
  const withoutQuery = {
    original_query: query,
    rewritten_query,
    filters: mutable.filters,
    boosts: mutable.boosts,
    exclusions: mutable.exclusions,
    retrieval_strategy: mutable.retrieval_strategy,
    matched_policies: mutable.matched_policies,
    consumed_phrases: mutable.consumed_phrases,
    explanation: mutable.explanation
  };

  return {
    ...withoutQuery,
    elasticsearch_query: buildElasticsearchQuery(withoutQuery)
  };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchPolicy(query: string, policy: Policy): MatchResult {
  const matchedBy: string[] = [];
  const consumedPhrases: string[] = [];

  if (policy.match.phrase && query.includes(normalize(policy.match.phrase))) {
    matchedBy.push(`phrase:${policy.match.phrase}`);
    consumedPhrases.push(normalize(policy.match.phrase));
  }

  const terms = policy.match.terms.map(normalize);
  if (terms.length > 0 && terms.every((term) => query.includes(term))) {
    matchedBy.push(`terms:${terms.join("+")}`);
  }

  if (policy.match.regex) {
    const regex = new RegExp(policy.match.regex, "i");
    if (regex.test(query)) {
      matchedBy.push(`regex:${policy.match.regex}`);
    }
  }

  return {
    matched: matchedBy.length > 0,
    matchedBy,
    consumedPhrases
  };
}

function applyPolicy(plan: MutablePlan, policy: Policy, matchedPolicy: MatchedPolicy): void {
  if (policy.action.add_filter) {
    addFilter(plan, policy.action.add_filter, policy.conflict_strategy, matchedPolicy);
  }

  if (policy.action.add_exclusion) {
    addExclusion(plan, policy.action.add_exclusion, matchedPolicy);
  }

  if (policy.action.add_boost) {
    addBoost(plan, policy.action.add_boost, policy.conflict_strategy, matchedPolicy);
  }

  if (policy.action.set_retrieval_strategy) {
    setRetrievalStrategy(plan, policy.action.set_retrieval_strategy, policy.conflict_strategy, matchedPolicy);
  }

  if (policy.action.remove_phrase) {
    consumePhrase(plan, normalize(policy.action.remove_phrase));
  }

  for (const phrase of matchedPolicy.consumed_phrases) {
    consumePhrase(plan, phrase);
  }

  plan.explanation.push(policy.explanation);
}

function addFilter(
  plan: MutablePlan,
  incoming: FilterSpec,
  conflictStrategy: Policy["conflict_strategy"],
  matchedPolicy: MatchedPolicy
): void {
  const existingIndex = plan.filters.findIndex((filter) => filter.field === incoming.field);
  if (existingIndex === -1) {
    plan.filters.push(incoming);
    return;
  }

  const existing = plan.filters[existingIndex];
  if (conflictStrategy === "override") {
    plan.filters[existingIndex] = incoming;
    matchedPolicy.conflict_notes.push(`overrode filter on ${incoming.field}`);
    return;
  }

  if (conflictStrategy === "restrict" && existing.operator === "lte" && incoming.operator === "lte") {
    const restrictedValue = Math.min(Number(existing.value), Number(incoming.value));
    plan.filters[existingIndex] = { ...incoming, value: restrictedValue };
    matchedPolicy.conflict_notes.push(`restricted ${incoming.field} to ${restrictedValue}`);
    return;
  }

  if (conflictStrategy === "restrict" && existing.operator === "gte" && incoming.operator === "gte") {
    const restrictedValue = Math.max(Number(existing.value), Number(incoming.value));
    plan.filters[existingIndex] = { ...incoming, value: restrictedValue };
    matchedPolicy.conflict_notes.push(`restricted ${incoming.field} to ${restrictedValue}`);
    return;
  }

  matchedPolicy.applied = false;
  matchedPolicy.conflict_notes.push(`kept existing filter on ${incoming.field}`);
}

function addExclusion(plan: MutablePlan, incoming: ExclusionSpec, matchedPolicy: MatchedPolicy): void {
  const exists = plan.exclusions.some(
    (exclusion) => exclusion.field === incoming.field && exclusion.value === incoming.value
  );

  if (!exists) {
    plan.exclusions.push(incoming);
  } else {
    matchedPolicy.conflict_notes.push(`deduplicated exclusion on ${incoming.field}`);
  }
}

function addBoost(
  plan: MutablePlan,
  incoming: BoostSpec,
  conflictStrategy: Policy["conflict_strategy"],
  matchedPolicy: MatchedPolicy
): void {
  const hasMatchingExclusion = plan.exclusions.some(
    (exclusion) => exclusion.field === incoming.field && exclusion.value === incoming.value
  );
  if (hasMatchingExclusion) {
    matchedPolicy.applied = false;
    matchedPolicy.conflict_notes.push(`boost ignored because ${incoming.field}:${incoming.value} is excluded`);
    return;
  }

  const existingIndex = plan.boosts.findIndex((boost) => boost.field === incoming.field && boost.value === incoming.value);
  if (existingIndex === -1) {
    plan.boosts.push(incoming);
    return;
  }

  if (conflictStrategy === "override") {
    plan.boosts[existingIndex] = incoming;
    matchedPolicy.conflict_notes.push(`overrode boost on ${incoming.field}:${incoming.value}`);
    return;
  }

  if (conflictStrategy === "soft_boost") {
    plan.boosts[existingIndex] = {
      ...incoming,
      weight: Math.max(plan.boosts[existingIndex].weight, incoming.weight)
    };
    matchedPolicy.conflict_notes.push(`kept strongest boost on ${incoming.field}:${incoming.value}`);
    return;
  }

  matchedPolicy.conflict_notes.push(`kept existing boost on ${incoming.field}:${incoming.value}`);
}

function setRetrievalStrategy(
  plan: MutablePlan,
  incoming: RetrievalStrategy,
  conflictStrategy: Policy["conflict_strategy"],
  matchedPolicy: MatchedPolicy
): void {
  if (plan.retrieval_strategy === "lexical" || conflictStrategy === "override") {
    plan.retrieval_strategy = incoming;
    return;
  }

  if (conflictStrategy === "soft_boost" && plan.retrieval_strategy !== incoming) {
    plan.retrieval_strategy = "hybrid_stub";
    matchedPolicy.conflict_notes.push("combined retrieval routes into hybrid_stub");
  }
}

function consumePhrase(plan: MutablePlan, phrase: string): void {
  if (!plan.consumed_phrases.includes(phrase)) {
    plan.consumed_phrases.push(phrase);
  }
}

function rewriteQuery(query: string, consumedPhrases: string[]): string {
  return consumedPhrases
    .reduce((rewritten, phrase) => rewritten.replaceAll(phrase, " "), query)
    .replace(/\s+/g, " ")
    .trim();
}
