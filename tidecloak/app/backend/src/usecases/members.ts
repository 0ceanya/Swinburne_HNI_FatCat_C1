import { DomainError, invalid, notFound } from "../domain/errors.js";
import { JoinRequest } from "../domain/joinRequest.js";
import { Member } from "../domain/member.js";
import { isTier, type Tier } from "../domain/tier.js";
import { actorOf, displayName, nowIso, requireMember, requireTier, type Deps, type Principal } from "./context.js";

/** Called on every sign-in: remember who this person is so others see a name, not a vuid. */
export class RecordSignIn {
  constructor(private d: Deps) {}
  execute(p: Principal): Member {
    const existing = this.d.members.get(p.id);
    const member = Member.seen({
      id: p.id, vuid: p.vuid, username: p.username, firstName: p.firstName, lastName: p.lastName,
      tideUserKey: p.tideUserKey, tiers: p.tiers, lastSeenAt: nowIso(this.d),
    }, existing);
    this.d.members.save(member);
    return member;
  }
}

function requireDirectory(d: Deps) {
  if (!d.directory.available) {
    throw new DomainError("DIRECTORY_UNAVAILABLE", "Member management needs the server's TideCloak admin credential (tidecloak/.env)", 409);
  }
}

export class ListMembers {
  constructor(private d: Deps) {}
  async execute(p: Principal) {
    requireTier(p, "owner", "director");
    requireDirectory(this.d);
    const [users, pending] = await Promise.all([this.d.directory.listUsers(), this.d.directory.pendingChanges()]);
    const local = new Map(this.d.members.list().map((m) => [m.id, m]));
    return {
      members: users.map((u) => ({
        ...u,
        displayName: `${u.lastName} ${u.firstName}`.trim() || u.username,
        resourceGroups: local.get(u.id)?.resourceGroups ?? ["general"],
        pendingChange: pending.some((c) => c.entityId === u.id),
        targetTiers: this.d.tierTargets.get(u.id),
      })),
      pendingChanges: pending,
      joinRequests: this.d.joinRequests.list("pending").map((r) => r.snapshot()),
      groups: this.d.members.groups(),
      tideConsoleUrl: this.d.settings.tideConsoleUrl,
    };
  }
}

/**
 * File the next role change towards a person's target tiers. TideCloak keeps one pending change
 * per person, so a tier change is a series: file one, a realm admin approves it in Tide, file the
 * next. The target is remembered so "continue" needs no input.
 */
async function fileTowardsTarget(d: Deps, userId: string, tiers: Tier[]) {
  d.tierTargets.set(userId, tiers);
  const outcome = await d.directory.setTiers(userId, tiers);
  if (outcome.status !== "pending") d.tierTargets.clear(userId);
  return outcome;
}

export class ChangeTier {
  constructor(private d: Deps) {}
  async execute(p: Principal, userId: string, tiers: unknown) {
    requireTier(p, "owner");
    requireDirectory(this.d);
    if (!Array.isArray(tiers) || !tiers.every(isTier)) throw invalid("tiers must be a list of tier names", "INVALID_TIERS");
    if (userId === p.id && !tiers.includes("owner")) throw new DomainError("SELF_DEMOTE", "You cannot remove your own owner tier here", 409);
    const outcome = await fileTowardsTarget(this.d, userId, tiers as Tier[]);
    this.d.audit.append({ at: nowIso(this.d), event: "member.tier_change_requested", actor: actorOf(p), documentId: null, contentHash: null,
      details: { userId, tiers, outcome: outcome.status } });
    return outcome;
  }
}

/** After a realm admin approved one change, file the next one towards the remembered target. */
export class ContinueTierChange {
  constructor(private d: Deps) {}
  async execute(p: Principal, userId: string) {
    requireTier(p, "owner");
    requireDirectory(this.d);
    const target = this.d.tierTargets.get(userId);
    if (!target) return { status: "unchanged" as const, detail: "No tier change in progress for this person", remaining: [] };
    return fileTowardsTarget(this.d, userId, target);
  }
}

/** Someone who signed up through Tide asks to join. Their identity is proven; the tier is the owner's call. */
export class FileJoinRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, input: { requestedTier?: unknown; note?: unknown; email?: unknown; name?: unknown }) {
    if (p.tiers.length > 0) throw new DomainError("ALREADY_MEMBER", "You are already a member of this organisation", 409);
    const existing = this.d.joinRequests.pendingFor(p.id);
    if (existing) return existing;
    const name = displayName(p) !== p.username ? displayName(p) : String(input.name ?? "").trim() || p.username;
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      const req = JoinRequest.file({ id: this.d.ids.id("join"), memberId: p.id, vuid: p.vuid, name, createdAt: now,
        requestedTier: input.requestedTier, note: input.note, email: input.email });
      this.d.joinRequests.save(req);
      this.d.audit.append({ at: now, event: "member.join_requested", actor: { id: p.id, name }, documentId: null, contentHash: null,
        details: { requestId: req.id, requestedTier: req.requestedTier } });
      return req;
    });
  }
}

export class MyJoinRequest {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    return this.d.joinRequests.latestFor(p.id);
  }
}

export class DecideJoinRequest {
  constructor(private d: Deps) {}
  async execute(p: Principal, id: string, decision: unknown, note: unknown) {
    requireTier(p, "owner");
    if (decision !== "approve" && decision !== "reject") throw invalid("decision must be approve or reject", "INVALID_DECISION");
    const req = this.d.joinRequests.get(id);
    if (!req) throw notFound("Join request");
    const now = nowIso(this.d);
    req.decide(decision === "approve" ? "approved" : "rejected", actorOf(p), now, String(note ?? ""));
    let outcome = null;
    if (decision === "approve") {
      requireDirectory(this.d);
      const tiers = [...new Set<Tier>([req.requestedTier, "viewer"])];
      outcome = await fileTowardsTarget(this.d, req.memberId, tiers);
    }
    this.d.joinRequests.save(req);
    this.d.audit.append({ at: now, event: "member.join_decided", actor: actorOf(p), documentId: null, contentHash: null,
      details: { requestId: id, decision, requestedTier: req.requestedTier, outcome: outcome?.status ?? null } });
    return { request: req, outcome };
  }
}

export class InviteMember {
  constructor(private d: Deps) {}
  async execute(p: Principal, input: { firstName?: string; lastName?: string; email?: string }) {
    requireTier(p, "owner");
    requireDirectory(this.d);
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80) throw invalid("First and last name are required", "INVALID_NAME");
    const email = input.email ? String(input.email).trim() : undefined;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid("That email address does not look right", "INVALID_EMAIL");
    const outcome = await this.d.directory.invite({ firstName, lastName, email });
    this.d.audit.append({ at: nowIso(this.d), event: "member.invited", actor: actorOf(p), documentId: null, contentHash: null,
      details: { name: `${lastName} ${firstName}`, userId: outcome.userId, outcome: outcome.status } });
    return outcome;
  }
}

export class GetInviteLink {
  constructor(private d: Deps) {}
  async execute(p: Principal, userId: string) {
    requireTier(p, "owner");
    requireDirectory(this.d);
    return { link: await this.d.directory.inviteLink(userId) };
  }
}

export class SetMemberGroups {
  constructor(private d: Deps) {}
  execute(p: Principal, memberId: string, groups: unknown) {
    requireTier(p, "owner");
    if (!Array.isArray(groups) || !groups.every((g) => this.d.members.groups().some((x) => x.id === g))) {
      throw invalid("Unknown resource group", "INVALID_GROUPS");
    }
    const member = this.d.members.get(memberId);
    if (!member) throw notFound("Member (they must sign in once first)");
    member.setResourceGroups(groups as string[]);
    this.d.members.save(member);
    return member;
  }
}

export class CreateResourceGroup {
  constructor(private d: Deps) {}
  execute(p: Principal, input: { id?: string; name?: string; costCentre?: string }) {
    requireTier(p, "owner");
    const id = String(input.id ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id) || !name) throw invalid("Group id must be lowercase letters/digits/dashes, and a name is required", "INVALID_GROUP");
    if (this.d.members.groups().some((g) => g.id === id)) throw new DomainError("DUPLICATE", "That group already exists");
    const group = { id, name, costCentre: String(input.costCentre ?? "").trim() };
    this.d.members.saveGroup(group);
    return group;
  }
}

export class ListGroups {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    requireMember(p);
    return this.d.members.groups();
  }
}

