export type Tier = "viewer" | "drafter" | "approver" | "director" | "owner";
export type DocumentType = "payment_voucher" | "e_invoice";
export type DocumentStatus = "draft" | "pending_approval" | "signed";
export type Sealing = "tide-relationship-v1" | "plaintext-dev";
export type SigningStatus = "collecting" | "quorum_met" | "signed" | "rejected" | "expired" | "cancelled";

export interface SealedValues {
  counterparty: string;
  bankAccount: string;
  description: string;
}

export interface Receipt {
  provider: "tide" | "mock-ca" | "dev-unsigned";
  signature: string;
  signedAt: string;
  covers: string;
  keyId?: string;
}

export interface Doc {
  id: string;
  number: string;
  type: DocumentType;
  title: string;
  amountDong: string;
  amountFormatted: string;
  resourceGroupId: string;
  sealing: Sealing;
  sealed: SealedValues;
  createdBy: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  editVersion: number;
  status: DocumentStatus;
  contentHash: string | null;
  submittedAt: string | null;
  signedAt: string | null;
  currentRequestId: string | null;
  receipts: Receipt[];
}

export interface Requirement {
  policyVersion: number;
  ruleId: string;
  label: string;
  requiredTiers: { tier: Tier; count: number }[];
  initiatorMayApprove: boolean;
  network: { role: string; threshold: number };
}

export interface Approval {
  memberId: string;
  name: string;
  countedAs: Tier;
  at: string;
  proof: { kind: string; dokenVerified?: boolean; deviceKey?: string };
}

export interface SigningRequest {
  id: string;
  documentId: string;
  documentNumber: string;
  documentType: DocumentType;
  amountDong: string;
  contentHash: string;
  requirement: Requirement;
  initiator: { memberId: string; name: string };
  mode: "tide" | "unsigned-dev";
  status: SigningStatus;
  approvals: Approval[];
  outstanding: Tier[];
  totalRequired: number;
  rejection: { name: string; reason: string; at: string } | null;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  closedReason: string | null;
  statement: string;
  auditAnchor: { seq: number; hash: string };
  tideRequest: string | null;
  tideRequestVersion: number;
  receipts: Receipt[];
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
  isRealmAdmin: boolean;
  canEncrypt: boolean;
  canDecrypt: boolean;
  resourceGroups: string[];
}

export interface PolicyRule {
  id: string;
  label: string;
  documentTypes: DocumentType[];
  minDong: string;
  maxDong: string | null;
  requiredTiers: { tier: Tier; count: number }[];
  initiatorMayApprove: boolean;
  network: { role: string; threshold: number };
  networkSigned: boolean | null;
}

export interface Policy {
  version: number;
  status: "proposed" | "active" | "retired";
  reason: string;
  proposedBy: { id: string; name: string };
  proposedAt: string;
  endorsements: { id: string; name: string; at: string }[];
  activatedAt: string | null;
  rules: PolicyRule[];
}

export interface TideSetup {
  isRealmAdmin: boolean;
  directoryAvailable: boolean;
  rules: {
    policyVersion: number; policyStatus: string; ruleId: string; label: string; role: string; threshold: number;
    signed: boolean; signatureVerified: boolean; signedBy: string | null; signedAt: string | null; unsigned: string;
  }[];
  sealedFields: { configured: boolean; signatureVerified: boolean; signedBy: string | null; unsigned: string };
}

export interface DirectoryMember {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  linked: boolean;
  enabled: boolean;
  tiers: Tier[];
  canEncrypt: boolean;
  canDecrypt: boolean;
  isRealmAdmin: boolean;
  resourceGroups: string[];
  /** A change request for this person is waiting for realm-admin approval. */
  pendingChange: boolean;
  /** Tiers a multi-step change is working towards (TideCloak files one role per approval). */
  targetTiers: Tier[] | null;
}

export interface JoinRequest {
  id: string;
  memberId: string;
  vuid: string;
  name: string;
  requestedTier: Tier;
  note: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string;
}

export interface PendingChange {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: string | null;
}

export interface Group {
  id: string;
  name: string;
  costCentre: string;
}

export interface AuditRow {
  seq: number;
  at: string;
  event: string;
  actor: { id: string; name: string };
  documentId: string | null;
  contentHash: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  length: number;
  brokenAtSeq: number | null;
  anchors: { requestId: string; documentId: string; auditSeq: number; signatureValid: boolean; matchesLog: boolean }[];
  checkedAt: string;
}

export interface ServerConfig {
  org: { name: string; taxCode: string };
  tideConsoleUrl: string;
  allowUnsignedDev: boolean;
  allowPlaintextDev: boolean;
}
