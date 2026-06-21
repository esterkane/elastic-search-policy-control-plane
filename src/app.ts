import Fastify from "fastify";
import { createElasticsearchClient, productIndex } from "./es.js";
import { createPlan, explainPlan } from "./planner.js";
import { loadPolicies } from "./policies.js";
import { logQuery } from "./learning/queryLog.js";
import { planRequestSchema, type Policy } from "./types.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  const es = createElasticsearchClient();
  let policies: Policy[] = await loadPolicies();

  app.get("/health", async () => {
    let elasticsearch = "unavailable";

    try {
      await es.ping();
      elasticsearch = "ok";
    } catch {
      elasticsearch = "unavailable";
    }

    return {
      status: "ok",
      elasticsearch,
      policies_loaded: policies.length
    };
  });

  app.post("/policies/reload", async () => {
    policies = await loadPolicies();

    return {
      status: "reloaded",
      policies_loaded: policies.length
    };
  });

  app.post("/plan", async (request, reply) => {
    const parsed = planRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Append-only, MEMORY_ENABLED-gated, best-effort: a no-op when disabled and
    // never throws into the request path, so /plan behaviour is unchanged by default.
    void logQuery(parsed.data.query, { source: "plan" });

    return createPlan(parsed.data.query, policies);
  });

  app.post("/search", async (request, reply) => {
    const parsed = planRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    void logQuery(parsed.data.query, { source: "search" });

    const plan = createPlan(parsed.data.query, policies);
    const body = plan.elasticsearch_query.query as Record<string, unknown>;
    const result = await es.search({
      index: productIndex,
      query: body
    });

    return {
      plan,
      hits: result.hits.hits.map((hit) => ({
        id: hit._id,
        score: hit._score,
        product: hit._source
      }))
    };
  });

  app.post("/explain", async (request, reply) => {
    const parsed = planRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const plan = createPlan(parsed.data.query, policies);

    return explainPlan(parsed.data.query, plan);
  });

  return app;
}
