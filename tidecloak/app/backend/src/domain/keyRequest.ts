import { DomainError } from "./errors.js";
import type { Level } from "./vaultKey.js";

/**
 * A request to the board about one key:
 *  - "seal": put a newly encrypted key into the vault (the network signs its ciphertext);
 *  - "release": decrypt it for the requester.
 *
 * Both need `quorum` distinct board members, the requester included. The other members approve
 * first, each in Tide's own window. The requester approves last, in their own browser, at the moment
 * they finish: their browser merges every approval and asks the network to seal or decrypt. That
 * way only the requester's browser ever holds a request with the full quorum, and the plaintext of a
 * released key only ever exists there.
 */
export type Operation = "seal" | "release";
export type RequestStatus = "collecting" | "ready" | "completed" | "rejected" | "cancelled" | "expired";

/** Who is acting, as verified from their Tide access token on this request. */
export interface MemberIdentity {
  memberId: string;
  vuid: string;
  name: string;
  /** Holds the board role the network counts. */
  onBoard: boolean;
}

export interface Approval {
  memberId: string;
  vuid: string;
  name: string;
  at: string;
  /** The approver's doken and their session-key signature, exactly as Tide's approval window produced them. */
  doken: string;
  signature: string;
  /** The doken carries a valid realm signature. */
  dokenVerified: boolean;
  /** Thumbprint of the device key the approver's API token is bound to (DPoP). */
  deviceKey: string | null;
}

export interface Rejection {
  memberId: string;
  name: string;
  reason: string;
  at: string;
}

export interface KeyRequestProps {
  id: string;
  keyId: string;
  keyName: string;
  keyLevel: Level;
  operation: Operation;
  quorum: number;
  requester: { memberId: string; vuid: string; name: string };
  /** Why the requester needs the key (release), or what it is for (seal). Shown to approvers. */
  reason: string;
  status: RequestStatus;
  /** base64 of the Tide request as drafted and initialised, with no approvals. Approvers approve exactly these bytes. */
  tideRequest: string;
  approvals: Approval[];
  rejection: Rejection | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  closedReason: string | null;
  /** The requester's own approval, checked when they finished. */
  finishedWith: { at: string; dokenVerified: boolean } | null;
}

export const REQUEST_LIFETIME_SECONDS: Record<Operation, number> = { seal: 7 * 24 * 3600, release: 3 * 24 * 3600 };

export class KeyRequest {
  private constructor(private props: KeyRequestProps) {}

  static open(p: Omit<KeyRequestProps, "status" | "approvals" | "rejection" | "closedAt" | "closedReason" | "finishedWith">): KeyRequest {
    if (!Number.isInteger(p.quorum) || p.quorum < 1) throw new RangeError("quorum must be a positive integer");
    return new KeyRequest({
      ...p,
      status: p.quorum === 1 ? "ready" : "collecting",
      approvals: [],
      rejection: null,
      closedAt: null,
      closedReason: null,
      finishedWith: null,
    });
  }

  static restore(props: KeyRequestProps): KeyRequest {
    return new KeyRequest({ ...props });
  }

  get id() { return this.props.id; }
  get keyId() { return this.props.keyId; }
  get operation() { return this.props.operation; }
  get status() { return this.props.status; }
  get quorum() { return this.props.quorum; }
  get requester() { return this.props.requester; }
  get approvals(): readonly Approval[] { return this.props.approvals; }
  get tideRequest() { return this.props.tideRequest; }
  get expiresAt() { return this.props.expiresAt; }

  /** Approvals needed from people other than the requester. */
  othersNeeded(): number {
    return this.props.quorum - 1;
  }

  isOpen(): boolean {
    return this.props.status === "collecting" || this.props.status === "ready";
  }

  isRequester(m: { memberId: string; vuid: string }): boolean {
    return m.memberId === this.props.requester.memberId || m.vuid === this.props.requester.vuid;
  }

  hasApproved(m: { memberId: string; vuid: string }): boolean {
    return this.props.approvals.some((a) => a.memberId === m.memberId || a.vuid === m.vuid);
  }

  /** Lazily applied whenever a request is loaded. Returns true if it just expired. */
  expireIfDue(now: string): boolean {
    if (this.isOpen() && now >= this.props.expiresAt) {
      this.props = { ...this.props, status: "expired", closedAt: now, closedReason: "Approval window closed" };
      return true;
    }
    return false;
  }

  private ensureOpen(now: string) {
    if (this.expireIfDue(now)) throw new DomainError("EXPIRED", "This request has expired");
    if (!this.isOpen()) throw new DomainError("CLOSED", `This request is ${this.props.status}`);
  }

  /**
   * Every rule, checked before anything is written: the requester never approves through here (their
   * approval comes when they finish), each person approves once, only board members count, and no
   * more approvals than the quorum needs.
   */
  checkCanApprove(m: MemberIdentity, now: string): void {
    this.ensureOpen(now);
    if (this.isRequester(m)) {
      throw new DomainError("REQUESTER_APPROVES_AT_FINISH", "You asked for this. Your approval is added when you finish, after the others approve.", 403);
    }
    if (!m.onBoard) throw new DomainError("NOT_ON_BOARD", "Only board members can approve", 403);
    if (this.hasApproved(m)) throw new DomainError("DUPLICATE_APPROVAL", "You have already approved this request");
    if (this.props.status === "ready") throw new DomainError("ALREADY_READY", "All the approvals this request needs are in");
  }

  approve(m: MemberIdentity, approval: Omit<Approval, "memberId" | "vuid" | "name" | "at">, now: string): void {
    this.checkCanApprove(m, now);
    const approvals = [...this.props.approvals, { memberId: m.memberId, vuid: m.vuid, name: m.name, at: now, ...approval }];
    this.props = { ...this.props, approvals, status: approvals.length >= this.othersNeeded() ? "ready" : "collecting" };
  }

  reject(m: MemberIdentity, reason: string, now: string): void {
    this.ensureOpen(now);
    if (this.isRequester(m)) throw new DomainError("USE_CANCEL", "Cancel your own request instead of rejecting it");
    if (!m.onBoard) throw new DomainError("NOT_ON_BOARD", "Only board members can reject", 403);
    if (!reason.trim()) throw new DomainError("REASON_REQUIRED", "Say why you are rejecting", 400);
    this.props = {
      ...this.props, status: "rejected", closedAt: now, closedReason: "Rejected",
      rejection: { memberId: m.memberId, name: m.name, reason: reason.trim().slice(0, 500), at: now },
    };
  }

  cancel(m: { memberId: string; vuid: string }, now: string): void {
    this.ensureOpen(now);
    if (!this.isRequester(m)) throw new DomainError("NOT_REQUESTER", "Only the person who asked can cancel", 403);
    this.props = { ...this.props, status: "cancelled", closedAt: now, closedReason: "Cancelled by the requester" };
  }

  /** Only the requester finishes, and only once everyone else they need has approved. */
  checkCanFinish(m: { memberId: string; vuid: string }, now: string): void {
    this.ensureOpen(now);
    if (!this.isRequester(m)) throw new DomainError("NOT_REQUESTER", "Only the person who asked can finish this request", 403);
    if (this.props.status !== "ready") {
      throw new DomainError("NOT_READY", `Waiting for ${this.othersNeeded() - this.props.approvals.length} more approval(s)`);
    }
  }

  finish(m: { memberId: string; vuid: string }, dokenVerified: boolean, now: string): void {
    this.checkCanFinish(m, now);
    this.props = {
      ...this.props, status: "completed", closedAt: now,
      closedReason: this.props.operation === "seal" ? "Sealed in the vault" : `Unlocked for ${this.props.requester.name}`,
      finishedWith: { at: now, dokenVerified },
    };
  }

  snapshot(): KeyRequestProps {
    return { ...this.props, approvals: this.props.approvals.map((a) => ({ ...a })) };
  }
}
