import type { webcrypto } from "node:crypto";
import type { ApprovalPolicy } from "../domain/approvalPolicy.js";
import type { AuditEntry, AuditEntryProps } from "../domain/auditEntry.js";
import type { Document, SignatureReceipt } from "../domain/document.js";
import type { JoinRequest } from "../domain/joinRequest.js";
import type { Member, ResourceGroup } from "../domain/member.js";
import type { SigningRequest } from "../domain/signingRequest.js";
import type { Tier } from "../domain/tier.js";
import type { RealmKeys } from "../tide/signatures.js";

export interface DocumentRepository {
  get(id: string): Document | null;
  list(filter?: { status?: string; type?: string; resourceGroupId?: string }): Document[];
  save(doc: Document): void;
  nextNumber(type: string): string;
}

export interface SigningRequestRepository {
  get(id: string): SigningRequest | null;
  list(filter?: { status?: string[]; documentId?: string }): SigningRequest[];
  save(req: SigningRequest): void;
}

export interface PolicyRepository {
  active(): ApprovalPolicy | null;
  get(version: number): ApprovalPolicy | null;
  list(): ApprovalPolicy[];
  save(policy: ApprovalPolicy): void;
  nextVersion(): number;
}

export interface StoredTidePolicy {
  kind: "signing-rule" | "sealed-fields";
  /** `${policyVersion}:${ruleId}` for a signing rule, "sealed-fields" otherwise. */
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
  groups(): ResourceGroup[];
  saveGroup(g: ResourceGroup): void;
}

export interface JoinRequestRepository {
  get(id: string): JoinRequest | null;
  pendingFor(memberId: string): JoinRequest | null;
  latestFor(memberId: string): JoinRequest | null;
  list(status?: string): JoinRequest[];
  save(r: JoinRequest): void;
}

/**
 * The tiers the owner wants a person to end up with. TideCloak files one role change at a time, so
 * this is what the next "continue" files after each approval.
 */
export interface TierTargetRepository {
  get(userId: string): Tier[] | null;
  set(userId: string, tiers: Tier[]): void;
  clear(userId: string): void;
}

/** Runs a function atomically: all its repository writes land, or none do. */
export type UnitOfWork = <T>(fn: () => T) => T;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  id(prefix: string): string;
}

/** The mock stand-in for VNPT SmartCA / Viettel MySign. */
export interface CaSigningGateway {
  /**
   * Sign an e-invoice. A real remote-signing CA would be asked to verify the Tide network's
   * signature over the approval statement before using the company's key; the mock does exactly that.
   */
  signInvoice(input: { contentHash: string; statement: Uint8Array; tideSignature: Uint8Array }): Promise<SignatureReceipt>;
  publicKeyJwk(): Promise<webcrypto.JsonWebKey>;
}

/** Org-level TideCloak administration, done with the server's admin credential (local dev). */
export interface TideDirectory {
  readonly available: boolean;
  adminPolicy(): Promise<string>;
  listUsers(): Promise<DirectoryUser[]>;
  setTiers(userId: string, tiers: Tier[]): Promise<ChangeOutcome>;
  invite(input: { firstName: string; lastName: string; email?: string }): Promise<ChangeOutcome & { userId: string | null }>;
  inviteLink(userId: string): Promise<string>;
  pendingChanges(): Promise<PendingChange[]>;
}

export interface DirectoryUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  linked: boolean;
  enabled: boolean;
  tiers: Tier[];
  canEncrypt: boolean;
  canDecrypt: boolean;
  isRealmAdmin: boolean;
}

export interface ChangeOutcome {
  /** "pending" means TideCloak queued it as a change request awaiting admin approval. */
  status: "applied" | "pending" | "unchanged";
  detail: string;
  /** Role changes still to file after this one is approved (TideCloak allows one pending per user). */
  remaining?: string[];
}

export interface PendingChange {
  id: string;
  actionType: string;
  entityType: string;
  /** The user/role/client the change is about. */
  entityId: string;
  summary: string;
  createdAt: string | null;
}

export interface TideConfig {
  vendorId: string;
  clientId: string;
  realm: string;
  authServerUrl: string;
  realmKeys: RealmKeys;
}
