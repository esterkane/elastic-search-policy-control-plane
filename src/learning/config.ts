/**
 * Shared configuration for the procedural-learning loop.
 *
 * The whole loop is gated behind `MEMORY_ENABLED` (default `false`). When the
 * flag is off:
 *  - query logging is a no-op (existing `/plan` `/explain` behaviour is byte-for-byte
 *    unchanged and reproducible), and
 *  - mining reads/derives nothing live.
 *
 * Nothing here imports the planner or mutates shared state, so importing this
 * module has no effect on the deterministic planning path.
 */

/** Default location of the append-only JSONL query log. */
export const DEFAULT_QUERY_LOG_PATH = "data/query-log.jsonl";

/** Default directory where safe candidate policies are staged (never live). */
export const DEFAULT_STAGING_DIR = "policies/staged";

/**
 * Whether the procedural-learning loop is active. Reads `MEMORY_ENABLED` from the
 * environment each call so tests can toggle it without module-cache games.
 * Anything other than the literal string `"true"` (case-insensitive) is off.
 */
export function memoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MEMORY_ENABLED ?? "").toLowerCase() === "true";
}
