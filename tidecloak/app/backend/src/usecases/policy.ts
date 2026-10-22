import { ApprovalPolicy, defaultRules, type ApprovalRuleProps } from "../domain/approvalPolicy.js";
import { DOCUMENT_TYPES, type DocumentType } from "../domain/document.js";
import { DomainError, invalid, notFound } from "../domain/errors.js";
import { isTier } from "../domain/tier.js";
import { fromBase64, toBase64 } from "../lib/encoding.js";
import { buildDataToVerify, parsePolicy, wrapSigned } from "../tide/policyBytes.js";
import { sealedFieldsPolicyFields, signingRuleFields, unsignedPolicy } from "../tide/signguardPolicies.js";
import { verifyRealmSignature } from "../tide/signatures.js";
import { actorOf, nowIso, requireMember, requireRealmAdmin, requireTier, type Deps, type Principal } from "./context.js";

const SYSTEM = { id: "system", name: "SignGuard" };
export const ruleKey = (policyVersion: number, ruleId: string) => `${policyVersion}:${ruleId}`;

/** On first start: policy v1 from the pitch's tiers. */
export function bootstrapPolicy(d: Deps): void {
  if (d.policies.list().length > 0) return;
  d.transaction(() => {
    const now = nowIso(d);
    const policy = ApprovalPolicy.propose(1, defaultRules(), "Initial policy from the SignGuard brief", SYSTEM, now);
    policy.activate(now, { bootstrap: true });
    d.policies.save(policy);
    d.audit.append({ at: now, event: "policy.bootstrapped", actor: SYSTEM, documentId: null, contentHash: null, details: { version: 1 } });
  });
}

export function ensureDefaultGroup(d: Deps): void {
  if (!d.members.groups().some((g) => g.id === "general")) d.members.saveGroup({ id: "general", name: "General", costCentre: "000" });
}

export class ViewPolicies {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    requireMember(p);
    return this.d.policies.list().map((policy) => ({
      policy,
      networkRules: policy.rules.map((r) => ({
        ruleId: r.id,
        signed: !!this.d.tidePolicies.get("signing-rule", ruleKey(policy.version, r.id)),
      })),
    }));
  }
}

interface RuleInput {
  id: string;
  label: string;
  documentTypes: string[];
  minDong: string;
  maxDong: string | null;
  requiredTiers: { tier: string; count: number }[];
  initiatorMayApprove: boolean;
  network: { role: string; threshold: number };
}

function parseRule(r: RuleInput): ApprovalRuleProps {
  const digits = (s: unknown, what: string) => {
    if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s)) throw invalid(`${what} must be digits`, "INVALID_RULE");
    return BigInt(s);
  };
  if (!Array.isArray(r.documentTypes) || !r.documentTypes.every((t) => DOCUMENT_TYPES.includes(t as DocumentType))) {
    throw invalid("Unknown document type in rule", "INVALID_RULE");
  }
  if (!Array.isArray(r.requiredTiers) || !r.requiredTiers.every((t) => isTier(t.tier))) throw invalid("Unknown tier in rule", "INVALID_RULE");
  return {
    id: String(r.id),
    label: String(r.label ?? "").slice(0, 120),
    documentTypes: r.documentTypes as DocumentType[],
    minDong: digits(r.minDong, "minDong"),
    maxDong: r.maxDong === null ? null : digits(r.maxDong, "maxDong"),
    requiredTiers: r.requiredTiers.map((t) => ({ tier: t.tier as never, count: Number(t.count) })),
    initiatorMayApprove: r.initiatorMayApprove === true,
    network: { role: String(r.network?.role ?? ""), threshold: Number(r.network?.threshold) },
  };
}

export class ProposePolicyChange {
  constructor(private d: Deps) {}
  execute(p: Principal, input: { rules: RuleInput[]; reason: string }) {
    requireTier(p, "owner");
    if (this.d.policies.list().some((x) => x.status === "proposed")) {
      throw new DomainError("PROPOSAL_OPEN", "Another policy change is already waiting for approval");
    }
    const rules = (input.rules ?? []).map(parseRule);
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      const policy = ApprovalPolicy.propose(this.d.policies.nextVersion(), rules, String(input.reason ?? ""), actorOf(p), now);
      this.d.policies.save(policy);
      this.d.audit.append({ at: now, event: "policy.proposed", actor: actorOf(p), documentId: null, contentHash: null,
        details: { version: policy.version, reason: input.reason } });
      return policy;
    });
  }
}

export class EndorsePolicy {
  constructor(private d: Deps) {}
  execute(p: Principal, version: number) {
    requireTier(p, "director", "owner");
    const policy = this.d.policies.get(version);
    if (!policy) throw notFound("Policy");
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      policy.endorse({ ...actorOf(p), tiers: p.tiers }, now);
      this.d.policies.save(policy);
      this.d.audit.append({ at: now, event: "policy.endorsed", actor: actorOf(p), documentId: null, contentHash: null, details: { version } });
      return policy;
    });
  }
}

export class ActivatePolicy {
  constructor(private d: Deps) {}
  execute(p: Principal, version: number) {
    requireTier(p, "owner");
    const policy = this.d.policies.get(version);
    if (!policy) throw notFound("Policy");
    const unsigned = policy.rules.filter((r) => !this.d.tidePolicies.get("signing-rule", ruleKey(version, r.id)));
    if (unsigned.length > 0 && !this.d.settings.allowUnsignedDev) {
      throw new DomainError("RULES_NOT_SIGNED", `Approve these network rules in Tide setup first: ${unsigned.map((r) => r.id).join(", ")}`);
    }
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      policy.activate(now);
      const current = this.d.policies.active();
      if (current && current.version !== version) {
        current.retire();
        this.d.policies.save(current);
      }
      this.d.policies.save(policy);
      this.d.audit.append({ at: now, event: "policy.activated", actor: actorOf(p), documentId: null, contentHash: null,
        details: { version, endorsedBy: policy.endorsements.map((e) => e.name) } });
      return policy;
    });
  }
}

/**
 * Tide setup: the realm admin signs each network rule (and the sealed-fields policy) once, in Tide's
 * enclave, under the realm's admin policy. The server builds the unsigned bytes and checks the
 * signature that comes back.
 */
export class TideSetup {
  constructor(private d: Deps) {}

  status(p: Principal) {
    requireMember(p);
    const policies = this.d.policies.list().filter((x) => x.status !== "retired");
    const sealed = this.d.tidePolicies.get("sealed-fields", "sealed-fields");
    return {
      isRealmAdmin: p.isRealmAdmin,
      directoryAvailable: this.d.directory.available,
      rules: policies.flatMap((policy) => policy.rules.map((r) => {
        const stored = this.d.tidePolicies.get("signing-rule", ruleKey(policy.version, r.id));
        return {
          policyVersion: policy.version, policyStatus: policy.status, ruleId: r.id, label: r.props.label,
          role: r.props.network.role, threshold: r.props.network.threshold,
          signed: !!stored, signatureVerified: stored?.signatureVerified ?? false, signedBy: stored?.signedBy.name ?? null, signedAt: stored?.signedAt ?? null,
          unsigned: toBase64(unsignedPolicy(signingRuleFields(this.d.tide.vendorId, this.d.tide.clientId, r.props.network.role, r.props.network.threshold))),
        };
      })),
      sealedFields: {
        configured: !!sealed,
        signatureVerified: sealed?.signatureVerified ?? false,
        signedBy: sealed?.signedBy.name ?? null,
        unsigned: toBase64(unsignedPolicy(sealedFieldsPolicyFields(this.d.tide.vendorId))),
      },
    };
  }

  async adminPolicy(p: Principal): Promise<string> {
    requireRealmAdmin(p);
    if (!this.d.directory.available) throw new DomainError("DIRECTORY_UNAVAILABLE", "The server has no TideCloak admin credential configured", 409);
    return this.d.directory.adminPolicy();
  }

  async storeRuleSignature(p: Principal, version: number, ruleId: string, signatureB64: string) {
    requireRealmAdmin(p);
    const policy = this.d.policies.get(version);
    const rule = policy?.ruleById(ruleId);
    if (!policy || !rule || policy.status === "retired") throw notFound("Rule");
    const fields = signingRuleFields(this.d.tide.vendorId, this.d.tide.clientId, rule.props.network.role, rule.props.network.threshold);
    return this.store(p, "signing-rule", ruleKey(version, ruleId), buildDataToVerify(fields), signatureB64, { version, ruleId });
  }

  async storeSealedSignature(p: Principal, signatureB64: string) {
    requireRealmAdmin(p);
    return this.store(p, "sealed-fields", "sealed-fields", buildDataToVerify(sealedFieldsPolicyFields(this.d.tide.vendorId)), signatureB64, {});
  }

  private async store(p: Principal, kind: "signing-rule" | "sealed-fields", key: string, dataToVerify: Uint8Array, signatureB64: string, details: Record<string, unknown>) {
    let signature: Uint8Array;
    try { signature = fromBase64(signatureB64); } catch { throw invalid("signature must be base64", "INVALID_ENCODING"); }
    if (signature.length !== 64) throw invalid("A Tide signature is 64 bytes", "INVALID_SIGNATURE");
    // The network checks this policy itself whenever it is used. We verify too, and keep the result
    // visible rather than refusing: if the network ever rebuilds the bytes differently, the policy
    // still works and the setup screen says so.
    const signatureVerified = await verifyRealmSignature(this.d.tide.realmKeys, signature, dataToVerify);
    const signed = toBase64(wrapSigned(dataToVerify, signature));
    parsePolicy(fromBase64(signed));
    const now = nowIso(this.d);
    this.d.transaction(() => {
      this.d.tidePolicies.save({ kind, key, signed, signatureVerified, signedBy: actorOf(p), signedAt: now });
      this.d.audit.append({ at: now, event: kind === "signing-rule" ? "tide.rule_signed" : "tide.encryption_policy_stored",
        actor: actorOf(p), documentId: null, contentHash: null, details: { ...details, signatureVerified } });
    });
    return { key, signatureVerified };
  }

  sealedPolicy(p: Principal): string {
    requireMember(p);
    const sealed = this.d.tidePolicies.get("sealed-fields", "sealed-fields");
    if (!sealed) throw new DomainError("SEALING_NOT_SET_UP", "Field encryption is not set up yet", 409);
    return sealed.signed;
  }
}
