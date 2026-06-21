/**
 * Policy miner — the procedural-learning half of the memory loop.
 *
 * It reads the append-only query log and derives **candidate policies**: when a
 * normalized search term recurs often enough across logged queries, the miner
 * proposes a low-priority `add_boost` policy that gives that term a soft ranking
 * lift. Each candidate is emitted as a plain policy object that VALIDATES against
 * the existing Zod `policySchema` in `src/types.ts` — there is no new policy
 * type and no parallel planner logic; a promoted candidate would flow through the
 * exact same `createPlan` path as a hand-authored policy.
 *
 * Determinism: the miner is a pure function of its inputs (log entries + config).
 * No randomness, no wall-clock, no network. The same log always yields the same
 * ordered candidate list, so mining is reproducible and testable offline.
 */

import { policySchema, type Policy } from "../types.js";

export type MinerConfig = {
  /** A term must appear in at least this many logged queries to be proposed. */
  minSupport: number;
  /** Priority assigned to mined candidates — intentionally low so they never
   *  outrank curated governance policies. */
  candidatePriority: number;
  /** Soft boost weight for mined candidates (kept well within the safety bound). */
  boostWeight: number;
  /** Field the mined boost targets. */
  boostField: string;
  /** Stopwords excluded from term frequency analysis. */
  stopwords: ReadonlySet<string>;
  /** Minimum term length to be considered (filters out noise like "a", "of"). */
  minTermLength: number;
};

export const DEFAULT_MINER_CONFIG: MinerConfig = {
  minSupport: 3,
  candidatePriority: 10,
  boostWeight: 1.2,
  boostField: "search_term",
  stopwords: new Set([
    "the", "a", "an", "and", "or", "for", "of", "to", "with", "without",
    "in", "on", "at", "by", "is", "it", "my", "me", "i", "best", "good"
  ]),
  minTermLength: 3
};

export type MinedCandidate = {
  /** The candidate policy (already validated against `policySchema`). */
  policy: Policy;
  /** How many logged queries contained the term — the evidence for this candidate. */
  support: number;
  /** The normalized term that triggered the candidate. */
  term: string;
};

const NORMALIZE_SPLIT = /[^a-z0-9]+/;

function normalize(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(query: string, config: MinerConfig): string[] {
  return normalize(query)
    .split(NORMALIZE_SPLIT)
    .filter((token) => token.length >= config.minTermLength && !config.stopwords.has(token));
}

/**
 * Count, per term, the number of *distinct logged queries* that contain it
 * (document frequency, not raw occurrence) so a single noisy query can't inflate
 * support by repeating a word.
 */
function termSupport(queries: string[], config: MinerConfig): Map<string, number> {
  const support = new Map<string, number>();
  for (const query of queries) {
    const unique = new Set(tokenize(query, config));
    for (const term of unique) {
      support.set(term, (support.get(term) ?? 0) + 1);
    }
  }
  return support;
}

function candidateId(term: string): string {
  return `mined-boost-${term}`;
}

/**
 * Build a candidate policy for a term and validate it against the live Zod
 * schema. Returns `undefined` if (defensively) it fails to validate — a miner
 * bug must never emit a non-conforming candidate.
 */
function buildCandidate(term: string, support: number, config: MinerConfig): MinedCandidate | undefined {
  const draft: Policy = {
    id: candidateId(term),
    name: `Mined soft boost for "${term}"`,
    priority: config.candidatePriority,
    match: {
      phrase: term,
      terms: [term]
    },
    action: {
      type: "add_boost",
      field: config.boostField,
      value: term,
      weight: config.boostWeight
    },
    conflict_strategy: "soft_boost",
    explanation:
      `Mined from query logs: "${term}" recurred in ${support} queries, ` +
      `so budget a soft ranking lift. Candidate only — staged for human review, not applied.`
  };

  const parsed = policySchema.safeParse(draft);
  return parsed.success ? { policy: parsed.data, support, term } : undefined;
}

/**
 * Mine candidate policies from a list of logged query strings.
 *
 * Deterministic ordering: candidates are sorted by support descending, then by
 * term ascending, so the output is stable regardless of log ordering.
 */
export function mineCandidates(
  queries: string[],
  config: MinerConfig = DEFAULT_MINER_CONFIG
): MinedCandidate[] {
  const support = termSupport(queries, config);

  const candidates: MinedCandidate[] = [];
  for (const [term, count] of support) {
    if (count < config.minSupport) {
      continue;
    }
    const candidate = buildCandidate(term, count, config);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => {
    if (a.support !== b.support) {
      return b.support - a.support;
    }
    return a.term.localeCompare(b.term);
  });

  return candidates;
}
