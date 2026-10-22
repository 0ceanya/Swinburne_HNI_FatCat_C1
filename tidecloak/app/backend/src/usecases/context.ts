import { forbidden } from "../domain/errors.js";
import type { MemberIdentity } from "../domain/keyRequest.js";
import type { Tier } from "../domain/tier.js";
import type { Actor } from "../domain/vaultKey.js";
import type {
  AuditLog, Clock, IdGenerator, KeyRequestRepository, MemberRepository, TideConfig, TideDirectory, TidePolicyRepository,
  UnitOfWork, VaultKeyRepository,
} from "./ports.js";

/** The caller, as read from their verified Tide access token on this request. */
export interface Principal {
  id: string;
  vuid: string;
  username: string;
  firstName: string;
  lastName: string;
  tiers: Tier[];
  realmRoles: string[];
  /** Holds the board role the Tide network counts (sg_viewer). */
  onBoard: boolean;
  isRealmAdmin: boolean;
  tideUserKey: string;
  /** Thumbprint of the device key this token is bound to (DPoP), if any. */
  deviceKey: string | null;
}

export const displayName = (p: Pick<Principal, "firstName" | "lastName" | "username">) =>
  `${p.lastName} ${p.firstName}`.trim() || p.username;

export const actorOf = (p: Principal): Actor => ({ id: p.id, name: displayName(p) });

export const identityOf = (p: Principal): MemberIdentity => ({ memberId: p.id, vuid: p.vuid, name: displayName(p), onBoard: p.onBoard });

export interface Settings {
  org: { name: string; taxCode: string };
  /** People on the board. A key's quorum is its level, capped at this. */
  boardSize: number;
  tideConsoleUrl: string;
}

export interface Deps {
  keys: VaultKeyRepository;
  requests: KeyRequestRepository;
  tidePolicies: TidePolicyRepository;
  audit: AuditLog;
  members: MemberRepository;
  transaction: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  tide: TideConfig;
  directory: TideDirectory;
  settings: Settings;
}

export const nowIso = (d: Deps) => d.clock.now().toISOString();
export const nowSeconds = (d: Deps) => Math.floor(d.clock.now().getTime() / 1000);

export function requireBoard(p: Principal): void {
  if (!p.onBoard) throw forbidden("You are not on the board. The board and its roles are fixed; ask the owner.", "NOT_ON_BOARD");
}

export function requireRealmAdmin(p: Principal): void {
  if (!p.isRealmAdmin) throw forbidden("This needs a TideCloak realm admin (tide-realm-admin)", "NOT_REALM_ADMIN");
}
