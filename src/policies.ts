import { readFile } from "node:fs/promises";
import { policySchema, type Policy } from "./types.js";

const policyArraySchema = policySchema.array();

export async function loadPolicies(path = "policies/sample-policies.json"): Promise<Policy[]> {
  const raw = await readFile(path, "utf8");
  return policyArraySchema.parse(JSON.parse(raw));
}

export function sortPolicies(policies: Policy[]): Policy[] {
  return [...policies].sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }

    return a.id.localeCompare(b.id);
  });
}
