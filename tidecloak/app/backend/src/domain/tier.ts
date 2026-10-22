/**
 * Tiers come from the member's TideCloak realm roles, never from local state. A member can hold
 * several (the owner also holds director). The board and its roles are fixed: SignGuard reads them
 * and never changes them.
 */
export const TIERS = ["viewer", "drafter", "approver", "director", "owner"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_ROLE: Record<Tier, string> = {
  viewer: "sg_viewer",
  drafter: "sg_drafter",
  approver: "sg_approver",
  director: "sg_director",
  owner: "sg_owner",
};

/**
 * The realm role every board member holds. The Tide network counts approvals from holders of this
 * role, so "N approvals" on the network means "N board members".
 */
export const BOARD_ROLE = TIER_ROLE.viewer;

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function tiersFromRoles(roles: readonly string[]): Tier[] {
  return TIERS.filter((t) => roles.includes(TIER_ROLE[t]));
}

/** On the board: holds the role the network counts. */
export const isBoardMember = (realmRoles: readonly string[]) => realmRoles.includes(BOARD_ROLE);
