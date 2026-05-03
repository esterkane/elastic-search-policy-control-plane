# elastic-search-policy-control-plane

A compact TypeScript/Node.js Elasticsearch project that demonstrates a governed e-commerce search control plane.

The service accepts raw user search text such as `cheap chocolate without peanuts`, `gift for grandpa`, or `wireless headphones under 100` and turns it into a deterministic execution plan:

- rewritten query text
- filters
- boosts
- exclusions
- retrieval strategy routing
- matched policies
- stable explanation payload
- generated Elasticsearch query body

## Control-Plane Pattern

Traditional search applications often bury query rewrites, ranking hints, category constraints, and compliance exclusions inside application code. A search control plane separates those decisions from execution.

In this project:

- Policies describe governed search behavior in JSON.
- The planner applies policies in deterministic priority order.
- Conflicts are handled explicitly with `override`, `restrict`, or `soft_boost`.
- The final execution plan is inspectable before it is sent to Elasticsearch.
- Elasticsearch remains the data/query execution layer, not the place where business intent is hidden.

That means teams can adjust governed behavior by changing policy data, reloading policies, and reviewing the explanation output without changing planner code.

## Quick Start

Requirements:

- Node.js latest LTS, currently the Node 24 line
- Docker and Docker Compose

Docker-first setup:

```bash
docker compose up -d elasticsearch api
docker compose exec api npm run ingest
docker compose exec api npm test
docker compose exec api npm run build
docker compose exec api npm run smoke
```

The API listens on `http://localhost:3000` and Elasticsearch listens on `http://localhost:9200`.

For detailed test cases and expected outputs, see [docs/TESTING.md](docs/TESTING.md).
For a ready-to-run HTTP request collection, see [docs/requests.http](docs/requests.http).

Host Node setup:

```bash
npm install
npm run setup
npm run ingest
npm run dev
```

Useful commands:

```bash
npm run dev
npm run setup
npm run ingest
npm test
npm run smoke
```

The `npm run setup` command starts both Elasticsearch and the API through Docker Compose.

## Endpoints

### `GET /health`

Returns service health, Elasticsearch availability, and loaded policy count.

### `POST /policies/reload`

Reloads `policies/sample-policies.json` from disk.

### `POST /plan`

Builds a deterministic execution plan without querying Elasticsearch.

```bash
curl -s http://localhost:3000/plan \
  -H "content-type: application/json" \
  -d '{"query":"cheap chocolate without peanuts"}'
```

Example plan shape:

```json
{
  "rewritten_query": "chocolate",
  "filters": [
    {
      "field": "price",
      "operator": "lte",
      "value": 25,
      "source_policy_id": "cheap-price-filter"
    }
  ],
  "boosts": [
    {
      "field": "price_band",
      "value": "budget",
      "weight": 1.4,
      "source_policy_id": "cheap-price-boost"
    }
  ],
  "exclusions": [
    {
      "field": "allergens",
      "value": "peanuts",
      "source_policy_id": "exclude-peanuts"
    }
  ],
  "retrieval_strategy": "lexical",
  "matched_policies": [
    {
      "id": "exclude-peanuts",
      "name": "Exclude peanut allergens",
      "priority": 100,
      "action": "add_exclusion",
      "conflict_strategy": "restrict",
      "consumed_phrases": ["without peanuts"],
      "explanation": "User explicitly excluded peanuts, so products with peanut allergens are blocked."
    }
  ],
  "explanation": {
    "original_query": "cheap chocolate without peanuts",
    "normalized_query": "cheap chocolate without peanuts",
    "consumed_phrases": ["cheap", "without peanuts"],
    "policy_trace": [],
    "conflict_trace": []
  },
  "elasticsearch_query": {}
}
```

The real response includes the complete policy trace and generated Elasticsearch `function_score` body.

### `POST /search`

Builds a plan, sends the generated query to Elasticsearch, and returns both the plan and hits.

```bash
curl -s http://localhost:3000/search \
  -H "content-type: application/json" \
  -d '{"query":"wireless headphones under 100"}'
```

### `POST /explain`

Returns the plan explanation, matched policies, and generated Elasticsearch query body without search hits.

## Policy Model

Policies live in [policies/sample-policies.json](policies/sample-policies.json).

Each policy has:

- `id`
- `name`
- `priority`
- `match.phrase`
- `match.terms`
- optional `match.regex`
- `action`
- `conflict_strategy`
- `explanation`

Supported actions:

- `add_filter`
- `add_exclusion`
- `add_boost`
- `set_retrieval_strategy`
- `remove_phrase`

Supported retrieval strategies:

- `lexical`
- `semantic_stub`
- `hybrid_stub`

Semantic and hybrid search are intentionally stubs in v1. They route to different generated query templates, but no real embeddings are required.

## How Policies Change Behavior

Suppose product wants `under 100` to win over the softer `cheap` hint. That behavior is policy-driven:

- `price-under-100` has priority `90` and uses `override`.
- `cheap-price-filter` has priority `50` and uses `soft_boost`.
- The planner applies the explicit price filter first.
- The later cheap policy cannot replace the already established hard price filter.

No planner code changes are required. Edit the JSON policy, call `POST /policies/reload`, and inspect `/plan` or `/explain`.

## Sample Data

Sample products live in [data/products.json](data/products.json). The ingestion command recreates the `products` index with mappings for:

- product text fields
- exact-match category, brand, price band, and allergens
- price ranges
- `semantic_text_stub` for v1 strategy-routing examples

## Trade-Offs And Limitations

- Policy matching is intentionally simple: phrase, terms, and optional regex.
- Semantic and hybrid retrieval are query-template stubs, not embedding-backed search.
- Conflict handling is explicit but compact; a production system would likely need typed domains for price, inventory, compliance, and personalization.
- Policy reload reads local JSON only. A real control plane may load signed policies from a registry with approvals and audit history.
- The planner is deterministic, but policy authors still need review tooling to avoid surprising combinations.

## Development Notes

Run tests:

```bash
npm test
```

Run type checking:

```bash
npm run build
```

Project layout:

- [src/planner.ts](src/planner.ts): deterministic policy application and conflict handling
- [src/queryBuilder.ts](src/queryBuilder.ts): Elasticsearch query generation
- [src/app.ts](src/app.ts): Fastify routes
- [scripts/ingest.ts](scripts/ingest.ts): local data ingestion
- [tests/planner.test.ts](tests/planner.test.ts): planner behavior tests
