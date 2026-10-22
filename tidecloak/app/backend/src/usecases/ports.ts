import type { AuditEntry, AuditEntryProps } from "../domain/auditEntry.js";
import type { KeyRequest } from "../domain/keyRequest.js";
import type { Member } from "../domain/member.js";
import type { Tier } from "../domain/tier.js";
import type { VaultKey } from "../domain/vaultKey.js";
import type { RealmKeys } from "../tide/signatures.js";

export interface VaultKeyRepository {
  get(id: string): VaultKey | null;
  list(filter?: { status?: string }): VaultKey[];
  save(key: VaultKey): void;
}

export interface KeyRequestRepository {
  get(id: string): KeyRequest | null;
  list(filter?: { status?: string[]; keyId?: string }): KeyRequest[];
  save(req: KeyRequest): void;
}

export interface StoredTidePolicy {
  kind: "vault-policy";
  /** vaultPolicyKey(threshold), e.g. "quorum-2". */
  key: string;
  /** base64 of the signed policy: container([dataToVerify, signature]). */
  signed: string;
  signatureVerified: boolean;
  signedBy: { id: string; name: string };
  signedAt: string;
}

export interface TidePolicyRepository {
  get(kind: StoredTidePolicy["kind"], key: string): StoredTidePolicy | null;
  list(kind?: StoredTidePolicy["kind"]): StoredTidePolicy[];
  save(p: StoredTidePolicy): void;
}

export interface AuditLog {
  append(e: Omit<AuditEntryProps, "seq" | "prevHash" | "hash">): AuditEntry;
  head(): AuditEntry | null;
  all(): AuditEntry[];
  /** Tests only: overwrite a row, to prove tampering is caught. */
  tamper?(seq: number, props: AuditEntryProps): void;
}

export interface MemberRepository {
  get(id: string): Member | null;
  list(): Member[];
  save(m: Member): void;
}

/** Runs a function atomically: all its repository writes land, or none do. */
export type UnitOfWork = <T>(fn: () => T) => T;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  id(prefix: string): string;
}

/**
 * Read-only view of the TideCloak realm, with the server's admin credential (local dev). SignGuard
 * never changes who is on the board or what roles they hold.
 */
export interface TideDirectory {
  readonly available: boolean;
  adminPolicy(): Promise<string>;
  listUsers(): Promise<DirectoryUser[]>;
}

export interface DirectoryUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  linked: boolean;
  enabled: boolean;
  tiers: Tier[];
  onBoard: boolean;
  isRealmAdmin: boolean;
}

export interface TideConfig {
  vendorId: string;
  clientId: string;
  realm: string;
  authServerUrl: string;
  realmKeys: RealmKeys;
}
