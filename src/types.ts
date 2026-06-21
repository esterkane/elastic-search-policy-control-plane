import { z } from "zod";

export const retrievalStrategySchema = z.enum(["lexical", "semantic_stub", "hybrid_stub"]);
export type RetrievalStrategy = z.infer<typeof retrievalStrategySchema>;

export const conflictStrategySchema = z.enum(["override", "restrict", "soft_boost"]);
export type ConflictStrategy = z.infer<typeof conflictStrategySchema>;

export const policyActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_filter"),
    field: z.string(),
    operator: z.enum(["eq", "lte", "gte", "contains"]),
    value: z.union([z.string(), z.number(), z.boolean()])
  }),
  z.object({
    type: z.literal("add_exclusion"),
    field: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()])
  }),
  z.object({
    type: z.literal("add_boost"),
    field: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    weight: z.number().positive()
  }),
  z.object({
    type: z.literal("set_retrieval_strategy"),
    strategy: retrievalStrategySchema
  }),
  z.object({
    type: z.literal("remove_phrase"),
    phrase: z.string()
  })
]);

export type PolicyAction = z.infer<typeof policyActionSchema>;

export const policySchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  match: z.object({
    phrase: z.string().optional(),
    terms: z.array(z.string()).default([]),
    regex: z.string().optional()
  }),
  action: policyActionSchema,
  conflict_strategy: conflictStrategySchema,
  explanation: z.string()
});

export type Policy = z.infer<typeof policySchema>;

export const planRequestSchema = z.object({
  query: z.string().min(1)
});

export type PlanRequest = z.infer<typeof planRequestSchema>;

export type FilterClause = {
  field: string;
  operator: "eq" | "lte" | "gte" | "contains";
  value: string | number | boolean;
  source_policy_id: string;
};

export type ExclusionClause = {
  field: string;
  value: string | number | boolean;
  source_policy_id: string;
};

export type BoostClause = {
  field: string;
  value: string | number | boolean;
  weight: number;
  source_policy_id: string;
};

export type MatchedPolicy = {
  id: string;
  name: string;
  priority: number;
  action: PolicyAction["type"];
  conflict_strategy: ConflictStrategy;
  consumed_phrases: string[];
  explanation: string;
};

export type PlanExplanation = {
  original_query: string;
  normalized_query: string;
  consumed_phrases: string[];
  policy_trace: MatchedPolicy[];
  conflict_trace: string[];
};

export type ExecutionPlan = {
  rewritten_query: string;
  filters: FilterClause[];
  boosts: BoostClause[];
  exclusions: ExclusionClause[];
  retrieval_strategy: RetrievalStrategy;
  matched_policies: MatchedPolicy[];
  explanation: PlanExplanation;
  elasticsearch_query: Record<string, unknown>;
};

export type ExplainResult = {
  query: string;
  rewritten_query: string;
  retrieval_strategy: RetrievalStrategy;
  matched_policies: MatchedPolicy[];
  explanation: PlanExplanation;
  elasticsearch_query: Record<string, unknown>;
};
