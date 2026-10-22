import type { ApprovalRequirement } from "./approvalPolicy.js";
import type { DocumentType, SignatureReceipt } from "./document.js";
import { DomainError } from "./errors.js";
import type { Tier } from "./tier.js";

export type SigningStatus = "collecting" | "quorum_met" | "signed" | "rejected" | "expired" | "cancelled";

/**
 * "tide": every approval is a signature in Tide's approval enclave, and the Tide network signs the
 * approval statement only once its contract agrees the quorum is met.
 * "unsigned-dev": local testing without the network rules. Never produced unless
 * SIGNGUARD_ALLOW_UNSIGNED_DEV=true, and always labelled as unprotected.
 */
export type SigningMode = "tide" | "unsigned-dev";

/** Who is acting, as verified from their Tide access token on this request. */
export interface MemberIdentity {
  memberId: string;
  vuid: string;
  name: string;
  tiers: Tier[];
}

export interface ApprovalProof {
  kind: "tide-enclave" | "dev-unsigned";
  /** Position of this approver's doken in the Tide request. */
  approvalIndex?: number;
  /** The approver's doken signature checked out against the realm key. */
  dokenVerified?: boolean;
  /** Thumbprint of the device key the approver's token is bound to (DPoP). */
  deviceKey?: string;
}

export interface Approval {
  memberId: string;
  vuid: string;
  name: string;
  tiers: Tier[];
  /** The tier slot this approval fills. */
  countedAs: Tier;
  at: string;
  proof: ApprovalProof;
}

export interface Rejection {
  memberId: string;
  name: string;
  reason: string;
  at: string;
}

export interface SigningRequestProps {
  id: string;
  documentId: string;
  documentNumber: string;
  documentType: DocumentType;
  amountDong: string;
  contentHash: string;
  requirement: ApprovalRequirement;
  initiator: { memberId: string; vuid: string; name: string };
  mode: SigningMode;
  status: SigningStatus;
  approvals: Approval[];
  rejection: Rejection | null;
  createdAt: string;
  expiresAt: string;
  /** base64 of the unsigned approval statement policy the network signs. */
  statement: string;
  auditAnchor: { seq: number; hash: string };
  /** base64 of the Tide request as it accumulates approvals; `version` guards concurrent writers. */
  tideRequest: string | null;
  tideRequestVersion: number;
  receipts: SignatureReceipt[];
  closedAt: string | null;
  closedReason: string | null;
}

export const REQUEST_LIFETIME_SECONDS = 7 * 24 * 3600;

/** Expand "director ×1, owner ×1" into one slot per approval needed. */
function slots(req: ApprovalRequirement): Tier[] {
  return req.requiredTiers.flatMap((r) => Array.from({ length: r.count }, () => r.tier));
}

/**
 * Maximum matching of approvers to tier slots (augmenting paths; at most 5 slots). An owner who also
 * holds director must not "use up" the director slot when a director could have filled it, so slots
 * are assigned optimally rather than first-come.
 */
export function matchApprovers(slotTiers: Tier[], approverTiers: Tier[][]): (number | null)[] {
  const slotOwner: (number | null)[] = slotTiers.map(() => null);
  const tryAssign = (a: number, seen: boolean[]): boolean => {
    for (let s = 0; s < slotTiers.length; s++) {
      const tier = slotTiers[s]!;
      if (seen[s] || !approverTiers[a]!.includes(tier)) continue;
      seen[s] = true;
      const current = slotOwner[s];
      if (current === null || current === undefined || tryAssign(current, seen)) {
        slotOwner[s] = a;
        return true;
      }
    }
    return false;
  };
  for (let a = 0; a < approverTiers.length; a++) tryAssign(a, slotTiers.map(() => false));
  return slotOwner;
}

const matchedCount = (m: (number | null)[]) => m.filter((x) => x !== null).length;

export class SigningRequest {
  private constructor(private props: SigningRequestProps) {}

  static open(props: Omit<SigningRequestProps, "status" | "approvals" | "rejection" | "tideRequest" | "tideRequestVersion" | "receipts" | "closedAt" | "closedReason">): SigningRequest {
    return new SigningRequest({
      ...props,
      status: "collecting",
      approvals: [],
      rejection: null,
      tideRequest: null,
      tideRequestVersion: 0,
      receipts: [],
      closedAt: null,
      closedReason: null,
    });
  }

  static restore(props: SigningRequestProps): SigningRequest {
    return new SigningRequest({ ...props });
  }

  get id() { return this.props.id; }
  get documentId() { return this.props.documentId; }
  get status() { return this.props.status; }
  get mode() { return this.props.mode; }
  get requirement() { return this.props.requirement; }
  get initiator() { return this.props.initiator; }
  get approvals(): readonly Approval[] { return this.props.approvals; }
  get contentHash() { return this.props.contentHash; }
  get statement() { return this.props.statement; }
  get tideRequest() { return this.props.tideRequest; }
  get tideRequestVersion() { return this.props.tideRequestVersion; }
  get expiresAt() { return this.props.expiresAt; }
  get auditAnchor() { return this.props.auditAnchor; }

  isOpen(): boolean {
    return this.props.status === "collecting" || this.props.status === "quorum_met";
  }

  /** Lazily applied: called whenever a request is loaded. Returns true if it just expired. */
  expireIfDue(now: string): boolean {
    if (this.isOpen() && now >= this.props.expiresAt) {
      this.props = { ...this.props, status: "expired", closedAt: now, closedReason: "Approval window closed" };
      return true;
    }
    return false;
  }

  private ensureOpen(now: string) {
    if (this.expireIfDue(now)) throw new DomainError("EXPIRED", "This request has expired");
    if (!this.isOpen()) throw new DomainError("CLOSED", `This request is ${this.props.status.replace("_", " ")}`);
  }

  isInitiator(m: { memberId: string; vuid: string }): boolean {
    return m.memberId === this.props.initiator.memberId || m.vuid === this.props.initiator.vuid;
  }

  /** Whether this member could take part at all: holds a required tier (and is not the initiator unless allowed). */
  isEligibleApprover(m: MemberIdentity): boolean {
    if (this.isInitiator(m) && !this.props.requirement.initiatorMayApprove) return false;
    return slots(this.props.requirement).some((t) => m.tiers.includes(t));
  }

  private assignment(approvers: { tiers: Tier[] }[]) {
    const slotTiers = slots(this.props.requirement);
    const match = matchApprovers(slotTiers, approvers.map((a) => a.tiers));
    return { slotTiers, match };
  }

  isQuorumMet(): boolean {
    const { slotTiers, match } = this.assignment(this.props.approvals);
    return matchedCount(match) === slotTiers.length;
  }

  /** Slots still needed, e.g. ["owner"], for the screens. */
  outstanding(): Tier[] {
    const { slotTiers, match } = this.assignment(this.props.approvals);
    return slotTiers.filter((_, i) => match[i] === null);
  }

  /**
   * Check every rule before anything is written, so a failure leaves no trace: wrong state, the
   * initiator approving their own request (the Đồng Tháp fix), a second approval by the same person,
   * or an approver whose tier is not needed.
   */
  checkCanApprove(m: MemberIdentity, now: string): Tier {
    this.ensureOpen(now);
    if (this.props.status === "quorum_met") throw new DomainError("QUORUM_MET", "All required approvals are in");
    if (this.isInitiator(m) && !this.props.requirement.initiatorMayApprove) {
      throw new DomainError("INITIATOR_CANNOT_APPROVE", "The person who submitted a document cannot approve it", 403);
    }
    if (this.props.approvals.some((a) => a.memberId === m.memberId || a.vuid === m.vuid)) {
      throw new DomainError("DUPLICATE_APPROVAL", "You have already approved this request");
    }
    const needed = slots(this.props.requirement);
    if (!needed.some((t) => m.tiers.includes(t))) {
      throw new DomainError("INELIGIBLE_TIER", `This request needs approval from: ${[...new Set(needed)].join(", ")}`, 403);
    }
    const before = this.assignment(this.props.approvals);
    const candidate = [...this.props.approvals, { tiers: m.tiers }];
    const after = this.assignment(candidate);
    if (matchedCount(after.match) <= matchedCount(before.match)) {
      throw new DomainError("TIER_ALREADY_SATISFIED", "The approvals your tier can give are already complete", 409);
    }
    const slot = after.match.findIndex((owner) => owner === candidate.length - 1);
    return slot >= 0 ? after.slotTiers[slot]! : m.tiers.find((t) => needed.includes(t))!;
  }

  approve(m: MemberIdentity, proof: ApprovalProof, now: string): void {
    const countedAs = this.checkCanApprove(m, now);
    const approvals = [...this.props.approvals, { memberId: m.memberId, vuid: m.vuid, name: m.name, tiers: [...m.tiers], countedAs, at: now, proof }];
    this.props = { ...this.props, approvals };
    if (this.isQuorumMet()) this.props = { ...this.props, status: "quorum_met" };
  }

  reject(m: MemberIdentity, reason: string, now: string): void {
    this.ensureOpen(now);
    if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Say why you are rejecting", 400);
    if (this.isInitiator(m)) throw new DomainError("USE_WITHDRAW", "Withdraw your own request instead of rejecting it");
    if (!this.isEligibleApprover(m)) throw new DomainError("INELIGIBLE_TIER", "Only an approver this request needs can reject it", 403);
    this.props = { ...this.props, status: "rejected", rejection: { memberId: m.memberId, name: m.name, reason: reason.trim(), at: now }, closedAt: now, closedReason: "Rejected" };
  }

  cancel(reason: string, now: string): void {
    if (!this.isOpen()) throw new DomainError("CLOSED", "This request is already closed");
    this.props = { ...this.props, status: "cancelled", closedAt: now, closedReason: reason };
  }

  /** Store the Tide request bytes; `expectedVersion` rejects a writer working from stale bytes. */
  setTideRequest(requestB64: string, expectedVersion: number, now: string): void {
    this.ensureOpen(now);
    if (expectedVersion !== this.props.tideRequestVersion) {
      throw new DomainError("STALE_REQUEST", "Someone else approved first. Reload and approve again.");
    }
    this.props = { ...this.props, tideRequest: requestB64, tideRequestVersion: this.props.tideRequestVersion + 1 };
  }

  complete(receipts: SignatureReceipt[], now: string): void {
    if (this.expireIfDue(now)) throw new DomainError("EXPIRED", "This request has expired");
    if (this.props.status !== "quorum_met") throw new DomainError("QUORUM_NOT_MET", "Approvals are not complete yet");
    if (receipts.length === 0) throw new DomainError("NO_RECEIPT", "A signature receipt is required");
    this.props = { ...this.props, status: "signed", receipts, closedAt: now, closedReason: "Signed" };
  }

  snapshot(): SigningRequestProps {
    return { ...this.props, approvals: this.props.approvals.map((a) => ({ ...a, tiers: [...a.tiers], proof: { ...a.proof } })), receipts: [...this.props.receipts] };
  }
}
