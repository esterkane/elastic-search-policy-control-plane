/**
 * Mining runner (npm script `mine`).
 *
 * Pipeline: read query log -> mine candidates -> safety-check -> stage survivors
 * -> print a report (proposed / staged / rejected-with-reasons).
 *
 * Gated by `MEMORY_ENABLED` (default false): when off, the runner does nothing
 * and stages nothing, so existing behaviour stays reproducible. Staging writes
 * only ever land in `policies/staged/` — the live `policies/sample-policies.json`
 * is never touched here and is never auto-reloaded.
 */

import { DEFAULT_QUERY_LOG_PATH, DEFAULT_STAGING_DIR, memoryEnabled } from "./config.js";
import { readQueryLog } from "./queryLog.js";
import { mineCandidates, type MinedCandidate } from "./miner.js";
import { screenCandidates, type SafetyReport } from "./safety.js";
import { stageCandidates, type StagedFile } from "./staging.js";
import { loadPolicies } from "../policies.js";
import type { Policy } from "../types.js";

export type MiningRunResult = {
  enabled: boolean;
  proposed: MinedCandidate[];
  safety: SafetyReport;
  staged: StagedFile[];
};

export type MiningRunOptions = {
  logPath?: string;
  stagingDir?: string;
  livePolicies?: Policy[];
  env?: NodeJS.ProcessEnv;
};

/**
 * Run the full mining pipeline. Returns a structured result; performs the
 * staging side effect (writes to the staging dir) only when enabled and there
 * are safe survivors.
 */
export async function runMining(options: MiningRunOptions = {}): Promise<MiningRunResult> {
  const enabled = memoryEnabled(options.env);
  if (!enabled) {
    return { enabled: false, proposed: [], safety: { staged: [], rejected: [] }, staged: [] };
  }

  const logPath = options.logPath ?? DEFAULT_QUERY_LOG_PATH;
  const stagingDir = options.stagingDir ?? DEFAULT_STAGING_DIR;
  const livePolicies = options.livePolicies ?? (await loadPolicies());

  const entries = await readQueryLog(logPath);
  const proposed = mineCandidates(entries.map((entry) => entry.query));
  const safety = screenCandidates(
    proposed.map((candidate) => candidate.policy),
    livePolicies
  );
  const staged = await stageCandidates(safety.staged, stagingDir);

  return { enabled: true, proposed, safety, staged };
}

export function formatReport(result: MiningRunResult): string {
  if (!result.enabled) {
    return [
      "MEMORY_ENABLED is not 'true' — procedural learning is disabled.",
      "No logs were mined and nothing was staged. Existing behaviour is unchanged.",
      "Set MEMORY_ENABLED=true to mine the query log into staged candidate policies."
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push("Policy mining report");
  lines.push("====================");
  lines.push(`Proposed candidates: ${result.proposed.length}`);
  for (const candidate of result.proposed) {
    lines.push(`  - ${candidate.policy.id} (support=${candidate.support}, term="${candidate.term}")`);
  }
  lines.push("");
  lines.push(`Staged (passed safety): ${result.staged.length}`);
  for (const file of result.staged) {
    lines.push(`  + ${file.policy.id} -> ${file.path}`);
  }
  lines.push("");
  lines.push(`Rejected (failed safety): ${result.safety.rejected.length}`);
  for (const rejection of result.safety.rejected) {
    lines.push(`  x ${rejection.policy.id} [${rejection.code}]: ${rejection.reason}`);
  }
  lines.push("");
  lines.push("Staged candidates are proposals only. They are NOT applied to live policies.");
  lines.push("Promotion to policies/sample-policies.json is an explicit human step.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const result = await runMining();
  // Report goes to stdout; this is a CLI tool, not the MCP transport.
  process.stdout.write(`${formatReport(result)}\n`);
}

// Run only when invoked directly (e.g. `npm run mine`), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run-mining.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`mining failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
