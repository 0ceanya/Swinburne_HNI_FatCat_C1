import type { Actor, DocumentType } from "./document.js";
import { DOCUMENT_TYPES } from "./document.js";
import { DomainError, invalid } from "./errors.js";
import type { Money } from "./money.js";
import { isTier, TIER_ROLE, type Tier } from "./tier.js";

export interface TierRequirement {
  tier: Tier;
  count: number;
}

/**
 * What the Tide network enforces for this rule, through the built-in contract
 * GenericRealmAccessThresholdRole:1: at least `threshold` approvers holding realm role `role`.
 * The app enforces the rest (distinct people, the initiator excluded, tier mix).
 */
export interface NetworkRule {
  role: string;
  threshold: number;
}

export interface ApprovalRuleProps {
  id: string;
  label: string;
  documentTypes: DocumentType[];
  /** Inclusive bounds in đồng; `maxDong` null means no upper bound. */
  minDong: bigint;
  maxDong: bigint | null;
  requiredTiers: TierRequirement[];
  /** Only the lowest band lets the drafter sign alone. */
  initiatorMayApprove: boolean;
  network: NetworkRule;
}

export class ApprovalRule {
  constructor(readonly props: ApprovalRuleProps) {
    const p = props;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id)) throw invalid(`Rule id '${p.id}' must be lowercase letters, digits or dashes`, "INVALID_RULE");
    if (p.documentTypes.length === 0 || p.documentTypes.some((t) => !DOCUMENT_TYPES.includes(t))) {
      throw invalid(`Rule '${p.id}' has an unknown document type`, "INVALID_RULE");
    }
    if (p.minDong < 0n || (p.maxDong !== null && p.maxDong < p.minDong)) throw invalid(`Rule '${p.id}' has an empty amount range`, "INVALID_RULE");
    const total = p.requiredTiers.reduce((n, r) => n + r.count, 0);
    if (total < 1 || total > 5) throw invalid(`Rule '${p.id}' must require 1 to 5 approvals`, "INVALID_RULE");
    for (const r of p.requiredTiers) {
      if (!isTier(r.tier) || !Number.isInteger(r.count) || r.count < 1) throw invalid(`Rule '${p.id}' has an invalid tier requirement`, "INVALID_RULE");
    }
    if (!Number.isInteger(p.network.threshold) || p.network.threshold < 1 || p.network.threshold > total) {
      throw invalid(`Rule '${p.id}': the network threshold must be between 1 and the number of approvals`, "INVALID_RULE");
    }
    if (!/^sg_[a-z]+$/.test(p.network.role)) throw invalid(`Rule '${p.id}': network role must be an sg_ role`, "INVALID_RULE");
    if (p.initiatorMayApprove && total !== 1) throw invalid(`Rule '${p.id}': self-approval is only for single-approval rules`, "INVALID_RULE");
  }

  get id() { return this.props.id; }

  matches(type: DocumentType, amount: Money): boolean {
    const { minDong, maxDong, documentTypes } = this.props;
    return documentTypes.includes(type) && amount.dong >= minDong && (maxDong === null || amount.dong <= maxDong);
  }

  totalApprovals(): number {
    return this.props.requiredTiers.reduce((n, r) => n + r.count, 0);
  }
}

/** The requirement a SigningRequest keeps for life, even if the policy changes later. */
export interface ApprovalRequirement {
  policyVersion: number;
  ruleId: string;
  label: string;
  requiredTiers: TierRequirement[];
  initiatorMayApprove: boolean;
  network: NetworkRule;
}

export type PolicyStatus = "proposed" | "active" | "retired";

export interface ApprovalPolicyProps {
  version: number;
  status: PolicyStatus;
  rules: ApprovalRuleProps[];
  reason: string;
  proposedBy: Actor;
  proposedAt: string;
  endorsements: Array<Actor & { at: string }>;
  activatedAt: string | null;
}

export class ApprovalPolicy {
  readonly rules: ApprovalRule[];

  private constructor(private props: ApprovalPolicyProps) {
    this.rules = props.rules.map((r) => new ApprovalRule(r));
    const ids = new Set(this.rules.map((r) => r.id));
    if (ids.size !== this.rules.length) throw invalid("Rule ids must be unique", "INVALID_POLICY");
    ApprovalPolicy.checkCoverage(this.rules);
  }

  /**
   * Every amount of every document type must match exactly one rule, or a document could slip
   * through with no requirement, or two rules could disagree about it.
   */
  private static checkCoverage(rules: ApprovalRule[]) {
    for (const type of DOCUMENT_TYPES) {
      const ranges = rules
        .filter((r) => r.props.documentTypes.includes(type))
        .map((r) => ({ id: r.id, min: r.props.minDong, max: r.props.maxDong }))
        .sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : 0));
      let next = 0n;
      for (const r of ranges) {
        if (r.min !== next) {
          throw invalid(`Rules for ${type} ${r.min > next ? "leave a gap" : "overlap"} at ${next} đồng (rule '${r.id}')`, "INVALID_POLICY");
        }
        if (r.max === null) { next = -1n; break; }
        next = r.max + 1n;
      }
      if (next !== -1n) throw invalid(`Rules for ${type} must cover every amount (no rule above ${next - 1n} đồng)`, "INVALID_POLICY");
    }
  }

  static propose(version: number, rules: ApprovalRuleProps[], reason: string, by: Actor, now: string): ApprovalPolicy {
    if (!reason.trim()) throw invalid("Say why the policy is changing", "INVALID_POLICY");
    return new ApprovalPolicy({ version, status: "proposed", rules, reason: reason.trim(), proposedBy: by, proposedAt: now, endorsements: [], activatedAt: null });
  }

  static restore(props: ApprovalPolicyProps): ApprovalPolicy {
    return new ApprovalPolicy({ ...props });
  }

  get version() { return this.props.version; }
  get status() { return this.props.status; }
  get proposedBy() { return this.props.proposedBy; }
  get endorsements() { return this.props.endorsements; }

  ruleById(id: string): ApprovalRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  requirementFor(type: DocumentType, amount: Money): ApprovalRequirement {
    if (this.props.status !== "active") throw new DomainError("POLICY_NOT_ACTIVE", "Only the active policy applies to new requests");
    const rule = this.rules.find((r) => r.matches(type, amount));
    if (!rule) throw new DomainError("NO_RULE", "No approval rule covers this document");
    const p = rule.props;
    return {
      policyVersion: this.props.version,
      ruleId: p.id,
      label: p.label,
      requiredTiers: p.requiredTiers.map((r) => ({ ...r })),
      initiatorMayApprove: p.initiatorMayApprove,
      network: { ...p.network },
    };
  }

  /** "Owner + one other": a policy change needs a second person's endorsement before it goes live. */
  endorse(by: Actor & { tiers: Tier[] }, now: string): void {
    if (this.props.status !== "proposed") throw new DomainError("NOT_PROPOSED", "Only a proposed policy can be endorsed");
    if (by.id === this.props.proposedBy.id) throw new DomainError("SELF_ENDORSE", "The proposer cannot endorse their own change", 403);
    if (!by.tiers.some((t) => t === "director" || t === "owner")) throw new DomainError("INELIGIBLE", "Only a director or owner can endorse a policy change", 403);
    if (this.props.endorsements.some((e) => e.id === by.id)) throw new DomainError("DUPLICATE", "You already endorsed this change");
    this.props = { ...this.props, endorsements: [...this.props.endorsements, { id: by.id, name: by.name, at: now }] };
  }

  /** Bootstrap only: the first policy goes live without a second person, since none exists yet. */
  activate(now: string, opts: { bootstrap?: boolean } = {}): void {
    if (this.props.status !== "proposed") throw new DomainError("NOT_PROPOSED", "Only a proposed policy can be activated");
    if (!opts.bootstrap && this.props.endorsements.length === 0) {
      throw new DomainError("NEEDS_ENDORSEMENT", "A second director or owner must endorse this change first");
    }
    this.props = { ...this.props, status: "active", activatedAt: now };
  }

  retire(): void {
    if (this.props.status !== "active") throw new DomainError("NOT_ACTIVE", "Only the active policy can be retired");
    this.props = { ...this.props, status: "retired" };
  }

  snapshot(): ApprovalPolicyProps {
    return { ...this.props, rules: this.props.rules.map((r) => ({ ...r, requiredTiers: r.requiredTiers.map((t) => ({ ...t })), network: { ...r.network } })) };
  }
}

const M = 1_000_000n;

/** The pitch's tiers: <20M drafter alone; 20M–500M + director; >500M + director + owner. */
export function defaultRules(): ApprovalRuleProps[] {
  const all = [...DOCUMENT_TYPES];
  return [
    {
      id: "low",
      label: "Under 20M ₫: drafter alone, logged",
      documentTypes: all,
      minDong: 0n,
      maxDong: 20n * M - 1n,
      requiredTiers: [{ tier: "drafter", count: 1 }],
      initiatorMayApprove: true,
      network: { role: TIER_ROLE.drafter, threshold: 1 },
    },
    {
      id: "mid",
      label: "20M–500M ₫: drafter + director",
      documentTypes: all,
      minDong: 20n * M,
      maxDong: 500n * M,
      requiredTiers: [{ tier: "director", count: 1 }],
      initiatorMayApprove: false,
      network: { role: TIER_ROLE.director, threshold: 1 },
    },
    {
      id: "high",
      label: "Over 500M ₫: drafter + director + owner",
      documentTypes: all,
      minDong: 500n * M + 1n,
      maxDong: null,
      requiredTiers: [{ tier: "director", count: 1 }, { tier: "owner", count: 1 }],
      initiatorMayApprove: false,
      // The network counts two distinct sg_director holders (the owner also holds sg_director);
      // the app additionally requires one of them to be the owner.
      network: { role: TIER_ROLE.director, threshold: 2 },
    },
  ];
}
