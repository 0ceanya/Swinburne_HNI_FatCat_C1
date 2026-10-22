import { forbidden } from "../domain/errors.js";
import type { Actor } from "../domain/document.js";
import type { MemberIdentity } from "../domain/signingRequest.js";
import { isMember, type Tier } from "../domain/tier.js";
import type {
  AuditLog, CaSigningGateway, Clock, DocumentRepository, IdGenerator, JoinRequestRepository, MemberRepository,
  PolicyRepository, SigningRequestRepository, TideConfig, TideDirectory, TidePolicyRepository, TierTargetRepository, UnitOfWork,
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
  isRealmAdmin: boolean;
  canEncrypt: boolean;
  canDecrypt: boolean;
  tideUserKey: string;
  /** Thumbprint of the device key this token is bound to (DPoP), if any. */
  deviceKey: string | null;
}

export const displayName = (p: Pick<Principal, "firstName" | "lastName" | "username">) =>
  `${p.lastName} ${p.firstName}`.trim() || p.username;

export const actorOf = (p: Principal): Actor => ({ id: p.id, name: displayName(p) });

export const identityOf = (p: Principal): MemberIdentity => ({ memberId: p.id, vuid: p.vuid, name: displayName(p), tiers: p.tiers });

export interface Settings {
  org: { name: string; taxCode: string };
  /** Allow approvals without the Tide network when no signing rule exists. Never in a demo. */
  allowUnsignedDev: boolean;
  /** Allow storing sensitive fields unencrypted when the sealed-fields policy is missing. */
  allowPlaintextDev: boolean;
  tideConsoleUrl: string;
}

export interface Deps {
  documents: DocumentRepository;
  requests: SigningRequestRepository;
  policies: PolicyRepository;
  tidePolicies: TidePolicyRepository;
  audit: AuditLog;
  members: MemberRepository;
  joinRequests: JoinRequestRepository;
  tierTargets: TierTargetRepository;
  transaction: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  tide: TideConfig;
  ca: CaSigningGateway;
  directory: TideDirectory;
  settings: Settings;
}

export const nowIso = (d: Deps) => d.clock.now().toISOString();
export const nowSeconds = (d: Deps) => Math.floor(d.clock.now().getTime() / 1000);

export function requireMember(p: Principal): void {
  if (!isMember(p.tiers)) throw forbidden("You are not a member of this organisation yet. Ask the owner to assign you a tier.", "NOT_A_MEMBER");
}

export function requireTier(p: Principal, ...tiers: Tier[]): void {
  requireMember(p);
  if (!tiers.some((t) => p.tiers.includes(t))) throw forbidden(`This needs the ${tiers.join(" or ")} tier`, "INELIGIBLE_TIER");
}

export function requireRealmAdmin(p: Principal): void {
  if (!p.isRealmAdmin) throw forbidden("This needs a TideCloak realm admin (tide-realm-admin)", "NOT_REALM_ADMIN");
}
