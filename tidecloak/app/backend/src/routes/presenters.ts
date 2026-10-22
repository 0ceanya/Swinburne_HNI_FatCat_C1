import type { AuditEntry } from "../domain/auditEntry.js";
import type { KeyRequest } from "../domain/keyRequest.js";
import type { VaultKey } from "../domain/vaultKey.js";

/** Key metadata. The ciphertext is included: only the Tide network can open it, and only with the quorum. */
export function presentKey(key: VaultKey) {
  return key.snapshot();
}

/**
 * A request as every board member may see it. The approvers' dokens and signatures are left out:
 * they leave the server only in the requester's finish kit.
 */
export function presentRequest(req: KeyRequest) {
  const p = req.snapshot();
  return {
    id: p.id,
    keyId: p.keyId,
    keyName: p.keyName,
    keyLevel: p.keyLevel,
    operation: p.operation,
    quorum: p.quorum,
    othersNeeded: req.othersNeeded(),
    requester: { memberId: p.requester.memberId, name: p.requester.name },
    reason: p.reason,
    status: p.status,
    tideRequest: p.tideRequest,
    approvals: p.approvals.map((a) => ({ memberId: a.memberId, name: a.name, at: a.at, dokenVerified: a.dokenVerified })),
    rejection: p.rejection,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    closedAt: p.closedAt,
    closedReason: p.closedReason,
    finishedWith: p.finishedWith,
  };
}

export function presentAudit(e: AuditEntry) {
  return { ...e.props };
}
