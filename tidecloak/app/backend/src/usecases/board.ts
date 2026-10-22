import { Member } from "../domain/member.js";
import { nowIso, requireBoard, type Deps, type Principal } from "./context.js";

/** Called on every sign-in: remember who this person is so others see a name, not a vuid. */
export class RecordSignIn {
  constructor(private d: Deps) {}
  execute(p: Principal): Member {
    const member = Member.seen({
      id: p.id, vuid: p.vuid, username: p.username, firstName: p.firstName, lastName: p.lastName,
      tideUserKey: p.tideUserKey, tiers: p.tiers, onBoard: p.onBoard, lastSeenAt: nowIso(this.d),
    });
    this.d.members.save(member);
    return member;
  }
}

/**
 * The board, read-only. Who sits on it and what roles they hold is fixed in TideCloak; SignGuard
 * shows it and never changes it. With the admin credential the list comes from TideCloak itself,
 * otherwise from the people who have signed in.
 */
export class ListBoard {
  constructor(private d: Deps) {}
  async execute(p: Principal) {
    requireBoard(p);
    if (this.d.directory.available) {
      const users = await this.d.directory.listUsers();
      return {
        source: "tidecloak" as const,
        boardSize: this.d.settings.boardSize,
        members: users.map((u) => ({ ...u, displayName: `${u.lastName} ${u.firstName}`.trim() || u.username })),
      };
    }
    return {
      source: "sign-ins" as const,
      boardSize: this.d.settings.boardSize,
      members: this.d.members.list().map((m) => {
        const s = m.snapshot();
        return {
          id: s.id, username: s.username, firstName: s.firstName, lastName: s.lastName, linked: true, enabled: true,
          tiers: s.tiers, onBoard: s.onBoard, isRealmAdmin: false, displayName: m.displayName(),
        };
      }),
    };
  }
}
