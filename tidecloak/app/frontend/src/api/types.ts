export type Tier = "viewer" | "drafter" | "approver" | "director" | "owner";
export type Level = 1 | 2 | 3 | 4;
export type KeyStatus = "pending_seal" | "active" | "rejected";
export type Operation = "seal" | "release";
export type RequestStatus = "collecting" | "ready" | "completed" | "rejected" | "cancelled" | "expired";

export interface Actor {
  id: string;
  name: string;
}

export interface KeyKind {
  id: string;
  label: string;
  defaultLevel: Level;
  examples: string;
}

export interface VaultKey {
  id: string;
  name: string;
  kind: string;
  provider: string;
  description: string;
  hint: string;
  level: Level;
  quorum: number;
  status: KeyStatus;
  /** Network ciphertext. Only the Tide network can open it, and only with the quorum's approvals. */
  ciphertext: string | null;
  createdBy: Actor;
  createdAt: string;
  sealedAt: string | null;
  sealRequestId: string;
  releaseCount: number;
  lastReleasedAt: string | null;
  lastReleasedTo: Actor | null;
}

export interface KeyRequest {
  id: string;
  keyId: string;
  keyName: string;
  keyLevel: Level;
  operation: Operation;
  quorum: number;
  othersNeeded: number;
  requester: { memberId: string; name: string };
  reason: string;
  status: RequestStatus;
  /** The drafted request every approver approves, byte for byte. */
  tideRequest: string;
  approvals: { memberId: string; name: string; at: string; dokenVerified: boolean }[];
  rejection: { memberId: string; name: string; reason: string; at: string } | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  closedReason: string | null;
  finishedWith: { at: string; dokenVerified: boolean } | null;
}

export interface FinishKit {
  policy: string;
  approvals: { doken: string; signature: string; name: string }[];
}

export interface Me {
  id: string;
  vuid: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  tiers: Tier[];
  realmRoles: string[];
  onBoard: boolean;
  isRealmAdmin: boolean;
}

export interface ServerConfig {
  org: { name: string; taxCode: string };
  tideConsoleUrl: string;
  boardSize: number;
  kinds: KeyKind[];
  levels: { level: Level; label: string; quorum: number }[];
  tag: string;
}

export interface TideSetup {
  isRealmAdmin: boolean;
  directoryAvailable: boolean;
  boardSize: number;
  policies: { threshold: number; signed: boolean; signatureVerified: boolean; signedBy: string | null; signedAt: string | null; keysUsing: number; unsigned: string }[];
}

export interface BoardMember {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  linked: boolean;
  enabled: boolean;
  tiers: Tier[];
  onBoard: boolean;
  isRealmAdmin: boolean;
}

export interface AuditRow {
  seq: number;
  at: string;
  event: string;
  actor: Actor;
  keyId: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  length: number;
  brokenAtSeq: number | null;
  checkedAt: string;
}
