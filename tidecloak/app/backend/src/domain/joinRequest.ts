import { DomainError, invalid } from "./errors.js";
import { isTier, type Tier } from "./tier.js";

/** Tiers a newcomer may ask for. Owner is never self-requested. */
export const REQUESTABLE_TIERS: Tier[] = ["viewer", "drafter", "approver", "director"];

export type JoinStatus = "pending" | "approved" | "rejected";

export interface JoinRequestProps {
  id: string;
  /** The TideCloak user id (token `sub`) of the person who signed up through Tide. */
  memberId: string;
  vuid: string;
  name: string;
  requestedTier: Tier;
  note: string;
  email: string;
  status: JoinStatus;
  createdAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string;
}

/**
 * Someone created a Tide account through SignGuard's sign-up and asks to join the organisation.
 * Their identity is already proven by Tide; what the owner decides is which tier they get.
 */
export class JoinRequest {
  private constructor(private props: JoinRequestProps) {}

  static file(p: Pick<JoinRequestProps, "id" | "memberId" | "vuid" | "name" | "createdAt"> & { requestedTier: unknown; note?: unknown; email?: unknown }): JoinRequest {
    if (!isTier(p.requestedTier) || !REQUESTABLE_TIERS.includes(p.requestedTier)) {
      throw invalid(`Requested role must be one of: ${REQUESTABLE_TIERS.join(", ")}`, "INVALID_TIER");
    }
    const note = String(p.note ?? "").trim();
    const email = String(p.email ?? "").trim();
    if (note.length > 500) throw invalid("Keep the note under 500 characters", "INVALID_NOTE");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("That email address does not look right", "INVALID_EMAIL");
    if (!p.name.trim()) throw invalid("Your name is required", "INVALID_NAME");
    return new JoinRequest({
      id: p.id, memberId: p.memberId, vuid: p.vuid, name: p.name.trim(), requestedTier: p.requestedTier,
      note, email, status: "pending", createdAt: p.createdAt, decidedBy: null, decidedAt: null, decisionNote: "",
    });
  }

  static restore(props: JoinRequestProps): JoinRequest {
    return new JoinRequest({ ...props });
  }

  get id() { return this.props.id; }
  get memberId() { return this.props.memberId; }
  get status() { return this.props.status; }
  get requestedTier() { return this.props.requestedTier; }

  decide(decision: "approved" | "rejected", by: { id: string; name: string }, now: string, note = ""): void {
    if (this.props.status !== "pending") throw new DomainError("ALREADY_DECIDED", `This request was already ${this.props.status}`);
    if (by.id === this.props.memberId) throw new DomainError("SELF_DECISION", "You cannot decide your own join request", 403);
    this.props = { ...this.props, status: decision, decidedBy: by, decidedAt: now, decisionNote: note.trim().slice(0, 500) };
  }

  snapshot(): JoinRequestProps {
    return { ...this.props };
  }
}
