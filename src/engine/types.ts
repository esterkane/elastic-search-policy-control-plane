import { z } from "zod";

export const RetrievalStrategySchema = z.enum(["lexical", "semantic_stub", "hybrid_stub"]);
export type RetrievalStrategy = z.infer<typeof RetrievalStrategySchema>;

export const ConflictStrategySchema = z.enum(["override", "restrict", "soft_boost"]);
export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>;

export const MatchSchema = z.object({
  phrase: z.string().optional(),
  terms: z.array(z.string()).default([]),
  regex: z.string().optional()
});

export const FilterSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "lte", "gte", "in"]),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
});
export type FilterSpec = z.infer<typeof FilterSchema>;

export const BoostSchema = z.object({
  field: z.string(),
  value: z.union([z.string(), z.number()]),
  weight: z.number().positive()
});
export type BoostSpec = z.infer<typeof BoostSchema>;

export const ExclusionSchema = z.object({
  field: z.string(),
  value: z.union([z.string(), z.number()])
});
export type ExclusionSpec = z.infer<typeof ExclusionSchema>;

export const PolicyActionSchema = z.object({
  add_filter: FilterSchema.optional(),
  add_exclusion: ExclusionSchema.optional(),
  add_boost: BoostSchema.optional(),
  set_retrieval_strategy: RetrievalStrategySchema.optional(),
  remove_phrase: z.string().optional()
});
export type PolicyAction = z.infer<typeof PolicyActionSchema>;

export const PolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  match: MatchSchema,
  action: PolicyActionSchema,
  conflict_strategy: ConflictStrategySchema,
  explanation: z.string()
});
export type Policy = z.infer<typeof PolicySchema>;

export const PlanRequestSchema = z.object({
  query: z.string().min(1)
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export type MatchedPolicy = {
  id: string;
  name: string;
  priority: number;
  conflict_strategy: ConflictStrategy;
  explanation: string;
  matched_by: string[];
  consumed_phrases: string[];
  applied: boolean;
  conflict_notes: string[];
};

export type ExecutionPlan = {
  original_query: string;
  rewritten_query: string;
  filters: FilterSpec[];
  boosts: BoostSpec[];
  exclusions: ExclusionSpec[];
  retrieval_strategy: RetrievalStrategy;
  matched_policies: MatchedPolicy[];
  consumed_phrases: string[];
  elasticsearch_query: Record<string, unknown>;
  explanation: string[];
};
