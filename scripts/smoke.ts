const baseUrl = process.env.API_URL ?? "http://localhost:3000";

type Json = Record<string, unknown>;

async function request(path: string, body?: Json): Promise<Json> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as Json;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const health = await request("/health");
assert(health.status === "ok", "health status should be ok");
assert(health.elasticsearch === "ok", "health should report Elasticsearch ok");
assert(health.policies_loaded === 11, "health should report 11 loaded policies");

const chocolatePlan = await request("/plan", { query: "cheap chocolate without peanuts" });
assert(chocolatePlan.rewritten_query === "chocolate", "cheap chocolate query should rewrite to chocolate");
assert((chocolatePlan.exclusions as unknown[]).length === 1, "cheap chocolate query should exclude peanuts");

const giftExplain = await request("/explain", { query: "gift for grandpa" });
assert(giftExplain.retrieval_strategy === "semantic_stub", "gift query should route to semantic_stub");

const headphoneSearch = await request("/search", { query: "wireless headphones under 100" });
const hits = headphoneSearch.hits as Array<{ id: string }>;
assert(hits.some((hit) => hit.id === "p3"), "headphone search should return product p3");

console.log("Smoke tests passed:");
console.log("- /health reports API and Elasticsearch ready");
console.log("- /plan composes cheap + allergen policies");
console.log("- /explain routes broad gift intent to semantic_stub");
console.log("- /search returns p3 for wireless headphones under 100");
