import type { DocumentType, Policy, PolicyRule, Tier } from "@/api/types";

/** The rule that will apply to a document, for the editor's "this will need…" preview. */
export function ruleFor(policy: Policy | null | undefined, type: DocumentType, amountDong: string | null): PolicyRule | null {
  if (!policy || !amountDong || !/^\d+$/.test(amountDong)) return null;
  const amount = BigInt(amountDong);
  return policy.rules.find((r) =>
    r.documentTypes.includes(type) && amount >= BigInt(r.minDong) && (r.maxDong === null || amount <= BigInt(r.maxDong))) ?? null;
}

export function describeRequirement(rule: Pick<PolicyRule, "requiredTiers" | "initiatorMayApprove">): string {
  if (rule.initiatorMayApprove) return "You sign alone (logged)";
  const parts = rule.requiredTiers.map((t) => (t.count > 1 ? `${t.count} × ${t.tier}` : t.tier));
  return `Needs approval from: ${parts.join(" + ")}`;
}

/** "640M ₫ and above" style range for the policy table. */
export function describeRange(rule: Pick<PolicyRule, "minDong" | "maxDong">, fmt: (d: string) => string): string {
  if (rule.maxDong === null) return `${fmt(rule.minDong)} and above`;
  if (rule.minDong === "0") return `Below ${fmt((BigInt(rule.maxDong) + 1n).toString())}`;
  return `${fmt(rule.minDong)} – ${fmt(rule.maxDong)}`;
}

export const activePolicy = (policies: Policy[]) => policies.find((p) => p.status === "active") ?? null;

export const hasAnyTier = (tiers: Tier[], ...wanted: Tier[]) => wanted.some((t) => tiers.includes(t));
