import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { policySchema, type Policy } from "../src/types.js";
import { logQuery, readQueryLog } from "../src/learning/queryLog.js";
import { mineCandidates } from "../src/learning/miner.js";
import { checkCandidate, screenCandidates } from "../src/learning/safety.js";
import { stageCandidates } from "../src/learning/staging.js";
import { runMining, formatReport } from "../src/learning/run-mining.js";

const FIXTURE_LOG = "tests/fixtures/query-log.jsonl";

function enabledEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MEMORY_ENABLED: "true" };
}

function disabledEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MEMORY_ENABLED: "false" };
}

describe("query log", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qlog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("no-ops when MEMORY_ENABLED is false", async () => {
    const path = join(dir, "log.jsonl");
    const wrote = await logQuery("wireless headphones", { path, env: disabledEnv() });

    expect(wrote).toBe(false);
    expect(await readQueryLog(path)).toEqual([]);
  });

  it("appends an entry when MEMORY_ENABLED is true", async () => {
    const path = join(dir, "log.jsonl");
    const wrote = await logQuery("wireless headphones", {
      path,
      source: "plan",
      env: enabledEnv(),
      now: () => new Date("2026-06-21T00:00:00.000Z")
    });

    expect(wrote).toBe(true);
    expect(await readQueryLog(path)).toEqual([
      { query: "wireless headphones", ts: "2026-06-21T00:00:00.000Z", source: "plan" }
    ]);
  });

  it("returns an empty array for a missing log file", async () => {
    expect(await readQueryLog(join(dir, "does-not-exist.jsonl"))).toEqual([]);
  });

  it("skips blank and malformed lines when reading", async () => {
    const path = join(dir, "log.jsonl");
    await logQuery("first query", { path, env: enabledEnv(), now: () => new Date("2026-06-21T00:00:00.000Z") });
    // Append a malformed line directly via the logger's file (simulate corruption).
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not json\n\n", "utf8");
    await logQuery("second query", { path, env: enabledEnv(), now: () => new Date("2026-06-21T00:01:00.000Z") });

    const entries = await readQueryLog(path);
    expect(entries.map((e) => e.query)).toEqual(["first query", "second query"]);
  });
});

describe("policy miner", () => {
  it("mines expected candidates from the committed log fixture", async () => {
    const entries = await readQueryLog(FIXTURE_LOG);
    const candidates = mineCandidates(entries.map((e) => e.query));

    // Deterministic order: support desc, then term asc.
    // headphones=5 (queries 1-5), chocolate=3 (6-8), wireless=3 (1-3).
    expect(candidates.map((c) => ({ term: c.term, support: c.support }))).toEqual([
      { term: "headphones", support: 5 },
      { term: "chocolate", support: 3 },
      { term: "wireless", support: 3 }
    ]);
  });

  it("emits candidates that validate against the live Zod policy schema", async () => {
    const entries = await readQueryLog(FIXTURE_LOG);
    const candidates = mineCandidates(entries.map((e) => e.query));

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(() => policySchema.parse(candidate.policy)).not.toThrow();
      expect(candidate.policy.action.type).toBe("add_boost");
    }
  });

  it("is deterministic: same log yields identical output regardless of order", async () => {
    const entries = await readQueryLog(FIXTURE_LOG);
    const queries = entries.map((e) => e.query);
    const forward = mineCandidates(queries);
    const reversed = mineCandidates([...queries].reverse());

    expect(reversed).toEqual(forward);
  });

  it("ignores terms below the support threshold", () => {
    const candidates = mineCandidates(["unique alpha", "unique beta", "unique gamma"]);
    // "unique" hits support 3 -> candidate; alpha/beta/gamma are singletons.
    expect(candidates.map((c) => c.term)).toEqual(["unique"]);
  });
});

describe("safety check", () => {
  const livePolicies: Policy[] = [
    {
      id: "exclude-peanuts",
      name: "Exclude peanut allergens",
      priority: 100,
      match: { phrase: "without peanuts", terms: ["without", "peanuts"] },
      action: { type: "add_exclusion", field: "allergens", value: "peanuts" },
      conflict_strategy: "restrict",
      explanation: "Peanuts excluded."
    },
    {
      id: "boost-premium",
      name: "Boost premium audio",
      priority: 95,
      match: { phrase: "headphones", terms: ["headphones"] },
      action: { type: "add_boost", field: "search_term", value: "headphones", weight: 1.5 },
      conflict_strategy: "soft_boost",
      explanation: "Curated higher-priority boost on headphones."
    }
  ];

  function safeCandidate(): Policy {
    return {
      id: "mined-boost-chocolate",
      name: "Mined soft boost for chocolate",
      priority: 10,
      match: { phrase: "chocolate", terms: ["chocolate"] },
      action: { type: "add_boost", field: "search_term", value: "chocolate", weight: 1.2 },
      conflict_strategy: "soft_boost",
      explanation: "Mined candidate."
    };
  }

  it("stages a safe additive boost candidate", () => {
    const decision = checkCandidate(safeCandidate(), livePolicies);
    expect(decision.safe).toBe(true);
  });

  it("rejects a candidate whose boost weight is out of bounds", () => {
    const candidate = safeCandidate();
    candidate.action = { type: "add_boost", field: "search_term", value: "chocolate", weight: 9 };
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("out_of_bounds");
    }
  });

  it("rejects a candidate priority that enters the curated governance band", () => {
    const candidate = safeCandidate();
    candidate.priority = 99;
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("out_of_bounds");
    }
  });

  it("rejects unsafe widening: boosting a value an exclusion blocks", () => {
    const candidate = safeCandidate();
    candidate.action = { type: "add_boost", field: "allergens", value: "peanuts", weight: 1.2 };
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("unsafe_widening");
    }
  });

  it("rejects a candidate that would author a hard filter/exclusion automatically", () => {
    const candidate = safeCandidate();
    // A hard filter is a valid PolicyAction, but the safety gate rejects mined
    // candidates that author hard constraints automatically.
    candidate.action = { type: "add_filter", field: "price", operator: "lte", value: 25 };
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("unsafe_widening");
    }
  });

  it("rejects a disallowed conflict with a higher-priority policy on the same target", () => {
    const candidate = safeCandidate();
    candidate.id = "mined-boost-headphones";
    candidate.action = { type: "add_boost", field: "search_term", value: "headphones", weight: 1.2 };
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("disallowed_conflict");
    }
  });

  it("rejects an id collision with a live policy", () => {
    const candidate = safeCandidate();
    candidate.id = "exclude-peanuts";
    const decision = checkCandidate(candidate, livePolicies);
    expect(decision.safe).toBe(false);
    if (!decision.safe) {
      expect(decision.code).toBe("id_collision");
    }
  });

  it("partitions candidates into staged and rejected with reasons", () => {
    const unsafe = safeCandidate();
    unsafe.id = "mined-boost-headphones";
    unsafe.action = { type: "add_boost", field: "search_term", value: "headphones", weight: 1.2 };

    const report = screenCandidates([safeCandidate(), unsafe], livePolicies);
    expect(report.staged.map((p) => p.id)).toEqual(["mined-boost-chocolate"]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].code).toBe("disallowed_conflict");
    expect(report.rejected[0].reason).toContain("higher-priority");
  });
});

describe("staging store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stage-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes each candidate to its own JSON file under the staging dir", async () => {
    const policy: Policy = {
      id: "mined-boost-chocolate",
      name: "Mined soft boost for chocolate",
      priority: 10,
      match: { phrase: "chocolate", terms: ["chocolate"] },
      action: { type: "add_boost", field: "search_term", value: "chocolate", weight: 1.2 },
      conflict_strategy: "soft_boost",
      explanation: "Mined candidate."
    };

    const written = await stageCandidates([policy], dir);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(join(dir, "mined-boost-chocolate.json"));

    const onDisk = JSON.parse(await readFile(written[0].path, "utf8"));
    expect(policySchema.parse(onDisk)).toEqual(policy);
  });
});

describe("mining runner", () => {
  let stagingDir: string;

  beforeEach(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), "mine-"));
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  it("is inert when MEMORY_ENABLED is false (mines and stages nothing)", async () => {
    const result = await runMining({
      logPath: FIXTURE_LOG,
      stagingDir,
      livePolicies: [],
      env: disabledEnv()
    });

    expect(result.enabled).toBe(false);
    expect(result.proposed).toEqual([]);
    expect(result.staged).toEqual([]);
    expect(formatReport(result)).toContain("disabled");
  });

  it("mines the fixture, safety-screens, and stages survivors when enabled", async () => {
    // A live higher-priority policy on "headphones" -> that candidate must be rejected,
    // while "chocolate" and "wireless" survive.
    const livePolicies: Policy[] = [
      {
        id: "curated-headphones",
        name: "Curated headphones boost",
        priority: 90,
        match: { phrase: "headphones", terms: ["headphones"] },
        action: { type: "add_boost", field: "search_term", value: "headphones", weight: 1.5 },
        conflict_strategy: "soft_boost",
        explanation: "Curated."
      }
    ];

    const result = await runMining({
      logPath: FIXTURE_LOG,
      stagingDir,
      livePolicies,
      env: enabledEnv()
    });

    expect(result.enabled).toBe(true);
    expect(result.proposed.map((c) => c.term)).toEqual(["headphones", "chocolate", "wireless"]);
    expect(result.staged.map((f) => f.policy.id)).toEqual(["mined-boost-chocolate", "mined-boost-wireless"]);
    expect(result.safety.rejected.map((r) => r.policy.id)).toEqual(["mined-boost-headphones"]);
    expect(result.safety.rejected[0].code).toBe("disallowed_conflict");

    // Survivors are written to the staging dir — never to the live policy file.
    const staged = JSON.parse(await readFile(join(stagingDir, "mined-boost-chocolate.json"), "utf8"));
    expect(policySchema.parse(staged).id).toBe("mined-boost-chocolate");
  });

  it("never writes to the live policies file (staging is isolated)", async () => {
    const liveBefore = await readFile("policies/sample-policies.json", "utf8");
    await runMining({ logPath: FIXTURE_LOG, stagingDir, livePolicies: [], env: enabledEnv() });
    const liveAfter = await readFile("policies/sample-policies.json", "utf8");
    expect(liveAfter).toBe(liveBefore);
  });
});
