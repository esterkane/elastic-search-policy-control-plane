# Testing The Docker Environment

This project is easiest to run as a Docker-first local environment. The Compose stack includes:

- `elasticsearch`: local Elasticsearch 8.17.0 on `localhost:9200`
- `api`: Node 24 Fastify service on `localhost:3000`
- `node-modules`: a Compose volume for container-installed dependencies
- `es-data`: a Compose volume for Elasticsearch data

## 1. Start The Stack

From the project root:

```bash
docker compose up -d elasticsearch api
```

Check that both services are healthy:

```bash
docker compose ps
```

Expected:

- `elasticsearch` is `healthy`
- `api` is `healthy`
- port `9200` is mapped for Elasticsearch
- port `3000` is mapped for the API

If you want to watch API startup:

```bash
docker compose logs -f api
```

## 2. Ingest Sample Products

Run the ingest script inside the API container:

```bash
docker compose exec api npm run ingest
```

Expected output:

```text
Ingested 6 products into products.
```

This recreates the `products` index, so it is safe to rerun.

## 3. Run Unit Tests

Run deterministic planner tests:

```bash
docker compose exec api npm test
```

What this verifies:

- multiple policies compose correctly
- higher-priority price policies win
- exclusions survive later boosts
- gift intent routes to `semantic_stub`
- explain payload ordering is stable

Expected:

```text
Test Files  1 passed (1)
Tests  5 passed (5)
```

## 4. Run Type Checking

```bash
docker compose exec api npm run build
```

Expected:

```text
tsc --noEmit
```

with no TypeScript errors.

## 5. Run Smoke Tests

The smoke script calls the live API and requires Elasticsearch data to be ingested first.

```bash
docker compose exec api npm run smoke
```

What this verifies:

- `/health` reports API and Elasticsearch readiness
- `/plan` turns `cheap chocolate without peanuts` into a governed plan
- `/explain` routes `gift for grandpa` to `semantic_stub`
- `/search` returns product `p3` for `wireless headphones under 100`

Expected:

```text
Smoke tests passed:
- /health reports API and Elasticsearch ready
- /plan composes cheap + allergen policies
- /explain routes broad gift intent to semantic_stub
- /search returns p3 for wireless headphones under 100
```

## 6. Manual Endpoint Checks

Health:

```bash
curl http://localhost:3000/health
```

Plan:

```bash
curl -s http://localhost:3000/plan \
  -H "content-type: application/json" \
  -d '{"query":"cheap chocolate without peanuts"}'
```

What to inspect:

- `rewritten_query` is `chocolate`
- `filters` includes `price <= 25`
- `exclusions` includes `allergens: peanuts`
- `boosts` includes `price_band: budget`
- `matched_policies` are ordered by priority
- `explanation.consumed_phrases` includes `cheap` and `without peanuts`

Explain:

```bash
curl -s http://localhost:3000/explain \
  -H "content-type: application/json" \
  -d '{"query":"gift for grandpa"}'
```

What to inspect:

- `retrieval_strategy` is `semantic_stub`
- `matched_policies` includes `route-grandpa-gift`
- `elasticsearch_query` uses the `semantic_text_stub` query template

Search:

```bash
curl -s http://localhost:3000/search \
  -H "content-type: application/json" \
  -d '{"query":"wireless headphones under 100"}'
```

What to inspect:

- `plan.filters` includes `price <= 100`
- `plan.filters` includes `category = electronics/audio`
- `plan.elasticsearch_query.query.function_score.query.bool.must` uses `match_all` when the controlled phrases fully consume the query
- `hits` includes product `p3`

Conflict behavior:

```bash
curl -s http://localhost:3000/plan \
  -H "content-type: application/json" \
  -d '{"query":"cheap wireless headphones under 100"}'
```

What to inspect:

- `price-under-100` wins over `cheap-price-filter`
- `filters` keeps `price <= 100`
- `explanation.conflict_trace` includes `cheap-price-filter did not replace existing hard filter`

Policy reload:

```bash
docker compose exec api npm run smoke
curl -s -X POST http://localhost:3000/policies/reload
```

What to inspect:

- response is `status: reloaded`
- `policies_loaded` remains `11`

## 7. Stop Or Reset

Stop containers but keep data and installed dependencies:

```bash
docker compose down
```

Reset Elasticsearch data and container dependency volume:

```bash
docker compose down -v
```

After a volume reset, run:

```bash
docker compose up -d elasticsearch api
docker compose exec api npm run ingest
docker compose exec api npm run smoke
```
