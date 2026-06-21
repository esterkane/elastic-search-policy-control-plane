/**
 * Structured tool result/error contract for the MCP layer.
 *
 * MCP tools must never leak an internal stack trace or a raw Elasticsearch /
 * filesystem error into a result. Instead every failure is converted into a
 * small, structured payload:
 *
 *     {
 *       isError: true,
 *       errorCategory: "validation" | "transient" | "business",
 *       isRetryable: boolean,
 *       message: string,        // safe, human-readable summary
 *       details?: object        // optional, safe context only
 *     }
 *
 * Handlers throw one of the typed errors below for expected failures; the
 * `guard` wrapper wraps every tool handler so that *any* unexpected exception is
 * logged server-side (to stderr, never stdout — stdout is the MCP transport) and
 * returned as a generic, trace-free transient error.
 */

export type ErrorCategory = "validation" | "transient" | "business";

export type ToolErrorResult = {
  isError: true;
  errorCategory: ErrorCategory;
  isRetryable: boolean;
  message: string;
  details: Record<string, unknown>;
};

/** A successful tool result is the wrapped domain payload plus `isError: false`. */
export type ToolSuccessResult<T> = {
  isError: false;
  result: T;
};

export type ToolResult<T> = ToolSuccessResult<T> | ToolErrorResult;

/** An expected, classified tool failure carrying a category and retryability. */
export class ToolError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { retryable: boolean; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "ToolError";
    this.category = category;
    this.retryable = options.retryable;
    this.details = options.details ?? {};
  }
}

/** Bad or unsupported input (e.g. empty query). Not retryable. */
export class ToolValidationError extends ToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation", message, { retryable: false, details });
    this.name = "ToolValidationError";
  }
}

/**
 * A valid request that cannot be satisfied under current policy/configuration
 * (e.g. mutations are disabled). Retrying without changing config will not help.
 */
export class ToolBusinessError extends ToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("business", message, { retryable: false, details });
    this.name = "ToolBusinessError";
  }
}

/** A backend was momentarily unavailable. Safe to retry. */
export class ToolTransientError extends ToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("transient", message, { retryable: true, details });
    this.name = "ToolTransientError";
  }
}

/** Build a structured success payload wrapping a domain result. */
export function successResult<T>(result: T): ToolSuccessResult<T> {
  return { isError: false, result };
}

/** Build the structured error payload returned in place of a result. */
export function errorResult(
  category: ErrorCategory,
  message: string,
  options: { retryable: boolean; details?: Record<string, unknown> }
): ToolErrorResult {
  return {
    isError: true,
    errorCategory: category,
    isRetryable: options.retryable,
    message,
    details: options.details ?? {}
  };
}

/**
 * Heuristic: does this look like a transient connectivity failure from the
 * Elasticsearch client (or the filesystem when reloading policies)? We match on
 * error name/code rather than importing ES error classes, to keep this module
 * free of backend coupling.
 */
function isTransientBackendError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name;
  const code = (error as { code?: unknown }).code;
  const transientNames = new Set([
    "ConnectionError",
    "TimeoutError",
    "NoLivingConnectionsError"
  ]);
  const transientCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN"
  ]);

  return (
    transientNames.has(name) ||
    (typeof code === "string" && transientCodes.has(code))
  );
}

/**
 * Run a tool handler so no failure ever escapes as a stack trace.
 *
 * - `ToolError` subclasses become their structured category payload.
 * - Connectivity-looking errors become a retryable transient error.
 * - Anything else is logged to stderr with its message and returned as a
 *   generic, non-retryable transient error with no internal detail.
 */
export async function guard<T>(
  toolName: string,
  fn: () => Promise<ToolResult<T>>
): Promise<ToolResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ToolError) {
      return errorResult(error.category, error.message, {
        retryable: error.retryable,
        details: error.details
      });
    }

    if (isTransientBackendError(error)) {
      const kind = error instanceof Error ? error.name : "Error";
      // eslint-disable-next-line no-console -- diagnostics must go to stderr, never stdout (MCP transport).
      console.error(`mcp tool ${toolName}: backend unreachable (${kind})`);
      return errorResult(
        "transient",
        "A backend dependency is currently unreachable. Please retry shortly.",
        { retryable: true, details: { kind } }
      );
    }

    // eslint-disable-next-line no-console -- last-resort guard; full detail to stderr only.
    console.error(`mcp tool ${toolName} failed unexpectedly:`, error);
    return errorResult(
      "transient",
      "An unexpected internal error occurred while handling the request.",
      { retryable: false }
    );
  }
}
