import { readFile } from "node:fs/promises";
import path from "node:path";
import { Policy, PolicySchema } from "./types.js";

const DEFAULT_POLICY_PATH = path.resolve("policies", "sample-policies.json");

let cachedPolicies: Policy[] = [];

export async function loadPolicies(policyPath = DEFAULT_POLICY_PATH): Promise<Policy[]> {
  const raw = await readFile(policyPath, "utf8");
  const parsed = JSON.parse(raw);
  const policies = PolicySchema.array().parse(parsed);
  cachedPolicies = sortPolicies(policies);
  return cachedPolicies;
}

export function setPoliciesForRuntime(policies: Policy[]): Policy[] {
  cachedPolicies = sortPolicies(PolicySchema.array().parse(policies));
  return cachedPolicies;
}

export function getPolicies(): Policy[] {
  return cachedPolicies;
}

export function sortPolicies(policies: Policy[]): Policy[] {
  return [...policies].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }

    return left.id.localeCompare(right.id);
  });
}
