/**
 * Tiers come from the member's TideCloak realm roles, never from local state. A member can hold
 * several (an owner usually also holds director, so they can approve as either).
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

/** Realm roles Tide's built-in RelationshipAttestation:1 contract checks for sealed fields. */
export const ENCRYPT_ROLE = "_tide_encryptor";
export const DECRYPT_ROLE = "_tide_decryptor";

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function tiersFromRoles(roles: readonly string[]): Tier[] {
  return TIERS.filter((t) => roles.includes(TIER_ROLE[t]));
}

/**
 * Anyone holding any tier can read documents. Higher tiers do not imply lower ones in TideCloak, so
 * "viewer and above" means "holds at least one tier".
 */
export const isMember = (tiers: readonly Tier[]) => tiers.length > 0;
