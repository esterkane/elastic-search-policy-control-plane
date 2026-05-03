import Fastify from "fastify";
import { ZodError } from "zod";
import { createExecutionPlan } from "../engine/planner.js";
import { getPolicies, loadPolicies } from "../engine/policyStore.js";
import { PlanRequestSchema } from "../engine/types.js";
import { createElasticsearchClient } from "./elasticsearch.js";

export async function buildApp() {
  const app = Fastify({
    logger: true
  });
  const elasticsearch = createElasticsearchClient();

  if (getPolicies().length === 0) {
    await loadPolicies();
  }

  app.get("/health", async () => {
    return {
      ok: true,
      service: "elastic-search-policy-control-plane"
    };
  });

  app.post("/policies/reload", async () => {
    const policies = await loadPolicies();
    return {
      reloaded: true,
      policy_count: policies.length,
      policy_ids: policies.map((policy) => policy.id)
    };
  });

  app.post("/plan", async (request) => {
    const body = PlanRequestSchema.parse(request.body);
    return createExecutionPlan(body.query, getPolicies());
  });

  app.post("/explain", async (request) => {
    const body = PlanRequestSchema.parse(request.body);
    const plan = createExecutionPlan(body.query, getPolicies());

    return {
      query: body.query,
      rewritten_query: plan.rewritten_query,
      retrieval_strategy: plan.retrieval_strategy,
      consumed_phrases: plan.consumed_phrases,
      matched_policies: plan.matched_policies,
      explanation: plan.explanation,
      elasticsearch_query: plan.elasticsearch_query
    };
  });

  app.post("/search", async (request) => {
    const body = PlanRequestSchema.parse(request.body);
    const plan = createExecutionPlan(body.query, getPolicies());
    const response = await elasticsearch.search(plan.elasticsearch_query);

    return {
      plan,
      hits: response.hits.hits.map((hit) => ({
        id: hit._id,
        score: hit._score,
        product: hit._source
      }))
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: "invalid_request",
        details: error.issues
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      error: "internal_error",
      message: error.message
    });
  });

  return app;
}
