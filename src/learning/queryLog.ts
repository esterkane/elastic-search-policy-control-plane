/**
 * Lightweight, append-only query logging — the raw material the policy miner
 * learns from.
 *
 * Design constraints:
 *  - Reuses existing infra: a JSONL file on disk (one JSON object per line). No
 *    new vector DB, no new service.
 *  - `MEMORY_ENABLED`-gated: `logQuery` is a safe no-op when the flag is off, so
 *    enabling logging is opt-in and the planning path stays unchanged by default.
 *  - Never throws into the request path: a logging failure must not break `/plan`.
 */

import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_QUERY_LOG_PATH, memoryEnabled } from "./config.js";

export const queryLogEntrySchema = z.object({
  query: z.string().min(1),
  ts: z.string(),
  source: z.enum(["plan", "search", "explain"]).optional()
});

export type QueryLogEntry = z.infer<typeof queryLogEntrySchema>;

export type LogQueryOptions = {
  path?: string;
  source?: QueryLogEntry["source"];
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable env for deterministic tests. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Append one `{query, ts, source}` record to the JSONL log. No-op when
 * `MEMORY_ENABLED` is off. Returns `true` if a record was written.
 */
export async function logQuery(query: string, options: LogQueryOptions = {}): Promise<boolean> {
  if (!memoryEnabled(options.env)) {
    return false;
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const now = options.now ?? (() => new Date());
  const entry: QueryLogEntry = {
    query: trimmed,
    ts: now().toISOString(),
    ...(options.source ? { source: options.source } : {})
  };

  try {
    await appendFile(options.path ?? DEFAULT_QUERY_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    // Logging is best-effort instrumentation; never let it break the request path.
    return false;
  }
}

/**
 * Read and parse the JSONL query log. Blank lines are skipped; malformed lines
 * are dropped (defensively — the log is append-only instrumentation, not a
 * source of truth). A missing file yields an empty array.
 */
export async function readQueryLog(path = DEFAULT_QUERY_LOG_PATH): Promise<QueryLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries: QueryLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const result = queryLogEntrySchema.safeParse(parsed);
    if (result.success) {
      entries.push(result.data);
    }
  }

  return entries;
}
