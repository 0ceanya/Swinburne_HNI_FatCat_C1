import type { ApprovalPolicy } from "../domain/approvalPolicy.js";
import type { AuditEntry } from "../domain/auditEntry.js";
import type { Document } from "../domain/document.js";
import type { SigningRequest } from "../domain/signingRequest.js";

export function presentDocument(doc: Document) {
  const p = doc.snapshot();
  return {
    id: p.id,
    number: p.number,
    type: p.type,
    title: p.title,
    amountDong: p.amount.toString(),
    amountFormatted: p.amount.format(),
    resourceGroupId: p.resourceGroupId,
    sealing: p.sealing,
    sealed: p.sealed,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    editVersion: p.editVersion,
    status: p.status,
    contentHash: p.contentHash?.hex ?? null,
    submittedAt: p.submittedAt,
    signedAt: p.signedAt,
    currentRequestId: p.currentRequestId,
    receipts: p.receipts,
  };
}

export function presentRequest(req: SigningRequest) {
  const p = req.snapshot();
  return {
    id: p.id,
    documentId: p.documentId,
    documentNumber: p.documentNumber,
    documentType: p.documentType,
    amountDong: p.amountDong,
    contentHash: p.contentHash,
    requirement: p.requirement,
    initiator: { memberId: p.initiator.memberId, name: p.initiator.name },
    mode: p.mode,
    status: p.status,
    approvals: p.approvals.map((a) => ({ memberId: a.memberId, name: a.name, countedAs: a.countedAs, at: a.at, proof: a.proof })),
    outstanding: req.isOpen() ? req.outstanding() : [],
    totalRequired: p.requirement.requiredTiers.reduce((n, t) => n + t.count, 0),
    rejection: p.rejection,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    closedAt: p.closedAt,
    closedReason: p.closedReason,
    statement: p.statement,
    auditAnchor: p.auditAnchor,
    tideRequest: p.tideRequest,
    tideRequestVersion: p.tideRequestVersion,
    receipts: p.receipts,
  };
}

export function presentPolicy(policy: ApprovalPolicy, networkRules?: { ruleId: string; signed: boolean }[]) {
  const p = policy.snapshot();
  return {
    version: p.version,
    status: p.status,
    reason: p.reason,
    proposedBy: p.proposedBy,
    proposedAt: p.proposedAt,
    endorsements: p.endorsements,
    activatedAt: p.activatedAt,
    rules: p.rules.map((r) => ({
      id: r.id,
      label: r.label,
      documentTypes: r.documentTypes,
      minDong: r.minDong.toString(),
      maxDong: r.maxDong === null ? null : r.maxDong.toString(),
      requiredTiers: r.requiredTiers,
      initiatorMayApprove: r.initiatorMayApprove,
      network: r.network,
      networkSigned: networkRules?.find((n) => n.ruleId === r.id)?.signed ?? null,
    })),
  };
}

export function presentAudit(e: AuditEntry) {
  return { ...e.props };
}
