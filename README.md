# elastic-search-policy-control-plane

A compact TypeScript/Node.js Elasticsearch project that demonstrates a governed e-commerce search control plane.

The service turns raw user queries into deterministic execution plans containing rewritten query text, filters, boosts, exclusions, retrieval routing, matched policies, explanations, and the generated Elasticsearch query body.

## Control-Plane Pattern

Most search APIs blend user intent parsing, business rules, ranking tweaks, and backend query generation in one place. This project separates those concerns:

- The **control plane** evaluates versionable policies and emits an execution plan.
- The **data plane** executes the generated Elasticsearch query.
- The **explain plane** exposes why each policy fired and what it changed.

That means behavior such as “exclude peanut allergens” or “route gift intent to semantic search” can change by editing `policies/sample-policies.json`, then calling `POST /policies/reload`, without changing TypeScript code.

## Requirements

- Node.js latest LTS, 24 or newer
- Docker with Docker Compose

## Commands

```bash
npm install
npm run setup
npm run ingest
npm run dev
npm test
```

`npm run setup` starts local Elasticsearch on `http://localhost:9200`.

## Endpoints

- `GET /health`
- `POST /policies/reload`
- `POST /plan`
- `POST /search`
- `POST /explain`

All query endpoints accept:

```json
{
  "query": "cheap chocolate without peanuts"
}
```

## Example Plan

`POST /plan`

```json
{
  "query": "cheap chocolate without peanuts"
}
```

Example response excerpt:

```json
{
  "original_query": "cheap chocolate without peanuts",
  "rewritten_query": "chocolate",
  "filters": [
    {
      "field": "price",
      "operator": "lte",
      "value": 50
    }
  ],
  "boosts": [
    {
      "field": "tags",
      "value": "budget",
      "weight": 1.5
    }
  ],
  "exclusions": [
    {
      "field": "allergens",
      "value": "peanuts"
    }
  ],
  "retrieval_strategy": "lexical",
  "consumed_phrases": ["without peanuts", "cheap"],
  "matched_policies": [
    {
      "id": "p100-without-peanuts",
      "name": "Exclude peanut allergens",
      "priority": 100,
      "conflict_strategy": "restrict",
      "applied": true
    }
  ]
}
```

The full response also includes the generated Elasticsearch query body.

## Policy Model

Each policy has:

- `id`
- `name`
- `priority`
- `match.phrase`
- `match.terms`
- optional `match.regex`
- `action.add_filter`
- `action.add_exclusion`
- `action.add_boost`
- `action.set_retrieval_strategy`
- `action.remove_phrase`
- `conflict_strategy`: `override`, `restrict`, or `soft_boost`
- `explanation`

Policies are sorted by descending priority, then by `id` for stable tie-breaking.

## Sample Queries

```bash
curl -s http://localhost:3000/plan \
  -H "content-type: application/json" \
  -d '{"query":"cheap chocolate without peanuts"}'

curl -s http://localhost:3000/plan \
  -H "content-type: application/json" \
  -d '{"query":"gift for grandpa"}'

curl -s http://localhost:3000/search \
  -H "content-type: application/json" \
  -d '{"query":"wireless headphones under 100"}'
```

## How Policies Change Behavior

To change the behavior of `cheap`, edit `policies/sample-policies.json`. For example, raise the price ceiling from `50` to `75`, then run:

```bash
curl -s -X POST http://localhost:3000/policies/reload
```

The next plan will reflect the new policy immediately. No code redeploy is needed in this local demo.

## Trade-Offs And Limitations

- Semantic and hybrid search are stubs in v1. The planner only routes to `semantic_stub` or `hybrid_stub` and emits query templates.
- Matching is intentionally simple: phrase, all-terms, and optional regex checks.
- Conflict handling is explicit but compact. Real systems usually need field-specific merge semantics and policy audit history.
- The sample product data is tiny and exists only to make local ingestion and search concrete.
- This project favors deterministic explainability over natural-language query understanding.
