/**
 * Safety check — the gate every mined candidate must pass before it can be
 * staged. A candidate that fails ANY check is REJECTED (never staged); only
 * survivors are eligible for the staging store. Promotion of a staged candidate
 * to the live policy set is a separate, explicit human step and is out of scope
 * here.
 *
 * Checks (a candidate must pass all):
 *  1. Zod-valid — re-validates against the live `policySchema`.
 *  2. Bounded — its action stays within sanity bounds (e.g. boost weight range,
 *     candidate priority not in the curated/high band).
 *  3. No unsafe widening — it must not remove an existing exclusion, undo an
 *     existing filter, or boost a value an existing policy explicitly excludes
 *     (no broadening of access).
 *  4. No disallowed conflict — it must not collide with / override an existing
 *     HIGHER-priority policy targeting the same thing. Mined candidates are
 *     additive soft boosts only; anything that would shadow governance is rejected.
 *  5. No id collision — it must not reuse the id of an existing live policy.
 */

import { policySchema, type Policy, type PolicyAction } from "../types.js";

export type SafetyBounds = {
  /** Inclusive allowed range for any mined boost weight. */
  minBoostWeight: number;
  maxBoostWeight: number;
  /** A mined candidate's priority must be <= this (must not enter the curated band). */
  maxCandidatePriority: number;
};

export const DEFAULT_SAFETY_BOUNDS: SafetyBounds = {
  minBoostWeight: 1.0,
  maxBoostWeight: 2.0,
  maxCandidatePriority: 40
};

export type RejectedCandidate = {
  policy: Policy;
  /** First failing check, machine-readable. */
  code: SafetyRejectionCode;
  /** Human-readable reason for the rejection. */
  reason: string;
};

export type SafetyRejectionCode =
  | "invalid_schema"
  | "out_of_bounds"
  | "unsafe_widening"
  | "disallowed_conflict"
  | "id_collision";

export type SafetyDecision =
  | { safe: true; policy: Policy }
  | { safe: false; policy: Policy; code: SafetyRejectionCode; reason: string };

function boostTarget(action: PolicyAction): { field: string; value: unknown } | undefined {
  return action.type === "add_boost" ? { field: action.field, value: action.value } : undefined;
}

/**
 * Evaluate a single candidate against the existing live policies and bounds.
 * Returns the first failing check, or `{ safe: true }`.
 */
export function checkCandidate(
  candidate: Policy,
  livePolicies: Policy[],
  bounds: SafetyBounds = DEFAULT_SAFETY_BOUNDS
): SafetyDecision {
  // (1) Zod-valid.
  const parsed = policySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      safe: false,
      policy: candidate,
      code: "invalid_schema",
      reason: `Candidate does not validate against the policy schema: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    };
  }
  const policy = parsed.data;

  // (5) No id collision with a live policy.
  if (livePolicies.some((live) => live.id === policy.id)) {
    return {
      safe: false,
      policy,
      code: "id_collision",
      reason: `Candidate id "${policy.id}" already exists in the live policy set.`
    };
  }

  // (2) Sanity bounds.
  if (policy.priority > bounds.maxCandidatePriority) {
    return {
      safe: false,
      policy,
      code: "out_of_bounds",
      reason: `Candidate priority ${policy.priority} exceeds the max allowed for mined policies (${bounds.maxCandidatePriority}); it must not enter the curated governance band.`
    };
  }

  if (policy.action.type === "add_boost") {
    const { weight } = policy.action;
    if (weight < bounds.minBoostWeight || weight > bounds.maxBoostWeight) {
      return {
        safe: false,
        policy,
        code: "out_of_bounds",
        reason: `Boost weight ${weight} is outside the allowed range [${bounds.minBoostWeight}, ${bounds.maxBoostWeight}].`
      };
    }
  }

  // (3) No unsafe widening: a mined candidate may NOT remove protections.
  // Mined candidates are restricted to additive soft boosts. Anything that
  // could broaden access — removing an exclusion or filter — is rejected outright.
  if (policy.action.type === "add_exclusion" || policy.action.type === "add_filter") {
    // Mined candidates are not expected to author hard constraints; if a future
    // miner emits one, treat it as out of the safe envelope rather than guessing.
    return {
      safe: false,
      policy,
      code: "unsafe_widening",
      reason: `Mined candidate uses "${policy.action.type}"; mined policies are restricted to additive soft boosts and may not author hard filters/exclusions automatically.`
    };
  }

  const target = boostTarget(policy.action);
  if (target) {
    // A boost on a value that an existing exclusion blocks would effectively try
    // to resurface excluded content — unsafe widening of access.
    const collidesWithExclusion = livePolicies.some(
      (live) =>
        live.action.type === "add_exclusion" &&
        live.action.field === target.field &&
        live.action.value === target.value
    );
    if (collidesWithExclusion) {
      return {
        safe: false,
        policy,
        code: "unsafe_widening",
        reason: `Candidate boosts ${target.field}:${String(target.value)}, which an existing exclusion blocks; boosting it would widen access to excluded content.`
      };
    }

    // (4) No disallowed conflict with a HIGHER-priority policy that already acts
    // on the same boost target. Mined candidates must not shadow or contend with
    // curated, higher-priority governance.
    const higherPriorityConflict = livePolicies.some((live) => {
      if (live.priority <= policy.priority) {
        return false;
      }
      const liveTarget = boostTarget(live.action);
      return liveTarget !== undefined && liveTarget.field === target.field && liveTarget.value === target.value;
    });
    if (higherPriorityConflict) {
      return {
        safe: false,
        policy,
        code: "disallowed_conflict",
        reason: `A higher-priority live policy already governs boost target ${target.field}:${String(target.value)}; mined candidate must not contend with it.`
      };
    }
  }

  return { safe: true, policy };
}

export type SafetyReport = {
  staged: Policy[];
  rejected: RejectedCandidate[];
};

/**
 * Partition a list of candidates into those that pass the safety check (eligible
 * to stage) and those that are rejected (with reasons).
 */
export function screenCandidates(
  candidates: Policy[],
  livePolicies: Policy[],
  bounds: SafetyBounds = DEFAULT_SAFETY_BOUNDS
): SafetyReport {
  const staged: Policy[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    const decision = checkCandidate(candidate, livePolicies, bounds);
    if (decision.safe) {
      staged.push(decision.policy);
    } else {
      rejected.push({ policy: decision.policy, code: decision.code, reason: decision.reason });
    }
  }

  return { staged, rejected };
}
