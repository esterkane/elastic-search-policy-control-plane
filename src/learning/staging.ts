/**
 * Staging store for safe candidate policies.
 *
 * Survivors of the safety check are written here — to `policies/staged/` — and
 * NOWHERE else. This module deliberately has no path to `policies/sample-policies.json`
 * and never calls `/policies/reload`: staging must never auto-merge into the live
 * policy set and must never be auto-loaded by the planner. Promotion of a staged
 * candidate to live is an explicit, separate human action (e.g. moving the file
 * and reloading), out of scope for the learning loop.
 *
 * Each candidate is written as its own JSON file named by policy id, so a human
 * reviewer can inspect, edit, or delete individual proposals.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_STAGING_DIR } from "./config.js";
import type { Policy } from "../types.js";

export type StagedFile = {
  policy: Policy;
  path: string;
};

function safeFileName(id: string): string {
  // Policy ids are simple slugs; defensively strip anything path-relevant so a
  // crafted id cannot escape the staging directory.
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

/**
 * Write each safe candidate to its own JSON file under the staging directory.
 * Creates the directory if needed. Returns what was written and where.
 *
 * This is the ONLY writer in the learning loop, and it only ever writes under
 * `dir` (default `policies/staged/`) — never the live policy file.
 */
export async function stageCandidates(
  candidates: Policy[],
  dir: string = DEFAULT_STAGING_DIR
): Promise<StagedFile[]> {
  if (candidates.length === 0) {
    return [];
  }

  await mkdir(dir, { recursive: true });

  const written: StagedFile[] = [];
  for (const policy of candidates) {
    const path = join(dir, safeFileName(policy.id));
    await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    written.push({ policy, path });
  }

  return written;
}
