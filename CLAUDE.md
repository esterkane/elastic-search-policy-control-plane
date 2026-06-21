# elastic-search-policy-control-plane — Claude Code Instructions

A compact TypeScript/Node.js Elasticsearch project demonstrating a **governed e-commerce
search control plane**. It turns raw user search text (e.g. `cheap chocolate without peanuts`)
into a deterministic, inspectable execution plan — rewritten query, filters, boosts,
exclusions, retrieval-strategy routing, matched policies, an explanation payload, and a
generated Elasticsearch query body — before anything is sent to Elasticsearch.

## Run / test commands

All commands are run from the repository root. Node 24+ is required (`engines.node >= 24`).

### Docker-first (recommended)
```bash
docker compose up -d elasticsearch api   # start ES (9200) + Fastify API (3000)
docker compose exec api npm run ingest   # recreate `products` index + load sample data
docker compose exec api npm test         # vitest run
docker compose exec api npm run build     # tsc --noEmit (type check)
docker compose exec api npm run smoke    # scripts/smoke.ts end-to-end check
```

### Host Node
```bash
npm install
npm run setup     # docker compose up -d elasticsearch api
npm run ingest    # tsx scripts/ingest.ts  (needs ES reachable on ELASTICSEARCH_URL)
npm run dev       # tsx watch src/server.ts
```

### Individual gates (exact)
- Tests: `npm test`  (→ `vitest run`)
- Type check: `npm run build`  (→ `tsc --noEmit`, `strict: true`)
- Smoke: `npm run smoke`  (→ `tsx scripts/smoke.ts`, requires running stack)

There is **no CI workflow** (`.github/` absent), **no linter** (no ESLint/Prettier config),
and **no separate type-check beyond `tsc --noEmit`**. The de facto quality gate is
`npm test` + `npm run build` passing locally.

## Architecture in 5 lines

1. `src/types.ts` defines the Policy / ExecutionPlan model with Zod schemas; policies are JSON in `policies/sample-policies.json`, loaded + validated by `src/policies.ts`.
2. `src/planner.ts` (`createPlan`) deterministically applies policies in priority order (then `id` tiebreak) into filters/boosts/exclusions/strategy, with explicit conflict handling.
3. `src/queryBuilder.ts` turns a plan into an Elasticsearch `function_score` query body; `src/es.ts` is the ES client.
4. `src/app.ts` is the Fastify app exposing `GET /health`, `POST /policies/reload`, `POST /plan`, `POST /search`, `POST /explain`; `src/server.ts` boots it.
5. Elasticsearch is the data/query execution layer only — business intent lives in policy JSON, not in app code.

## Invariants I must never break

1. **Planner determinism.** `createPlan` must stay a pure, deterministic function of
   `(query, policies)`. Policy application order is fixed by `sortPolicies` (priority
   descending, then `id` ascending) in `src/policies.ts`. Do not introduce randomness,
   wall-clock time, network calls, or mutation of shared state into the planning path —
   the same inputs must always yield the same plan (the planner tests assert exact output).

2. **Quality gates pass.** `npm test` (vitest) and `npm run build` (`tsc --noEmit` under
   `strict: true`) must both pass. No `any` / type-suppression without a comment explaining
   why. There is no linter or CI to lean on, so these two commands are the gate.

3. **Provenance / auditability of every decision** (the control-plane analogue of
   "citations on every chunk"). Every filter, boost, and exclusion in a plan carries a
   `source_policy_id`, and every applied policy appears in `matched_policies` /
   `explanation.policy_trace` with its `consumed_phrases` and `explanation`; conflict
   resolutions are recorded in `explanation.conflict_trace`. Never emit a plan clause that
   cannot be traced back to the policy that produced it, and never drop the trace fields.

4. **No secrets in git.** Configuration is environment-only (`ELASTICSEARCH_URL`, `HOST`,
   `PORT`, `API_URL`) documented in `.env.example`. No keys/tokens/passwords belong in the
   repo, `docker-compose.yml`, or policy JSON. (ES runs with `xpack.security.enabled=false`
   for local single-node dev — this is a dev-only convenience, not a credential.)

### Repo-specific invariants
- Policies are **data, not code**: change governed behavior by editing
  `policies/sample-policies.json` and calling `POST /policies/reload` — not by special-casing
  queries in the planner. New policy capabilities go through the Zod schemas in `types.ts`.
- Conflict strategies (`override`, `restrict`, `soft_boost`) and actions (`add_filter`,
  `add_exclusion`, `add_boost`, `set_retrieval_strategy`, `remove_phrase`) are validated by
  the discriminated union in `types.ts`; adding a new action/strategy means updating the
  schema, the planner branch, and the query builder together.
- `semantic_stub` / `hybrid_stub` retrieval strategies are intentionally query-template
  stubs (no real embeddings in v1). Keep them as stubs unless explicitly asked to implement.
- All inbound request bodies are validated with `planRequestSchema` (`safeParse` → 400 on
  failure). Keep that validation; do not pass unvalidated user input to Elasticsearch.

## Definition of done

- [ ] `npm test` passes (vitest).
- [ ] `npm run build` passes (`tsc --noEmit`, strict — no new `any`/suppressions without a reason).
- [ ] Planner output remains deterministic; existing planner tests still pass and new
      behavior has tests in `tests/`.
- [ ] Provenance intact: every plan clause keeps its `source_policy_id` and the
      `policy_trace` / `conflict_trace` explanation fields are populated.
- [ ] No CI exists — run the gates locally and report results before calling it done.
- [ ] README / `docs/TESTING.md` updated if commands, endpoints, policy model, or behavior changed.
- [ ] No secrets added; config stays in env vars and is reflected in `.env.example`.

## External services & config

| Service | Detail |
|---|---|
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:8.17.0`, single-node, `xpack.security.enabled=false`, on `localhost:9200`. Client in `src/es.ts`, index name `products`. |
| API | Fastify 5 (Node 24) on `localhost:3000`. |

Config is env-only (`.env.example`): `HOST`, `PORT`, `ELASTICSEARCH_URL`, `API_URL`.
No external LLM / embedding providers — semantic/hybrid retrieval are stubs in v1.

## Trade-offs & limitations (self-described)
- Policy matching is intentionally simple: phrase, terms, optional regex.
- Semantic/hybrid retrieval are query-template stubs, not embedding-backed.
- Conflict handling is explicit but compact; production would need typed domains.
- Policy reload reads local JSON only — no signed registry, approvals, or audit history yet.
