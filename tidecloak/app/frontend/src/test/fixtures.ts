import type { Doc, Me, SigningRequest } from "@/api/types";

export const HASH = "3f9a" + "0".repeat(56) + "c21e";

export function makeRequest(over: Partial<SigningRequest> = {}): SigningRequest {
  return {
    id: "req_1", documentId: "doc_1", documentNumber: "PC-0142", documentType: "payment_voucher", amountDong: "640000000",
    contentHash: HASH,
    requirement: { policyVersion: 1, ruleId: "high", label: "Over 500M ₫: drafter + director + owner", requiredTiers: [{ tier: "director", count: 1 }, { tier: "owner", count: 1 }], initiatorMayApprove: false, network: { role: "sg_director", threshold: 2 } },
    initiator: { memberId: "u-acct", name: "Trần Bình" }, mode: "tide", status: "collecting",
    approvals: [{ memberId: "u-dir", name: "Lê Cường", countedAs: "director", at: "2026-10-22T03:00:00Z", proof: { kind: "tide-enclave", dokenVerified: true } }],
    outstanding: ["owner"], totalRequired: 2, rejection: null, createdAt: "2026-10-22T02:00:00Z", expiresAt: "2026-10-29T02:00:00Z",
    closedAt: null, closedReason: null, statement: "U1RBVEVNRU5U", auditAnchor: { seq: 4, hash: "a".repeat(64) },
    tideRequest: "UkVRVUVTVA==", tideRequestVersion: 2, receipts: [],
    ...over,
  };
}

export function makeDoc(over: Partial<Doc> = {}): Doc {
  return {
    id: "doc_1", number: "PC-0142", type: "payment_voucher", title: "Thanh toán thiết bị", amountDong: "640000000", amountFormatted: "640.000.000 ₫",
    resourceGroupId: "general", sealing: "plaintext-dev", sealed: { counterparty: "Công ty TNHH Minh Phát", bankAccount: "VCB 0011004821", description: "" },
    createdBy: { id: "u-acct", name: "Trần Bình" }, createdAt: "2026-10-22T01:00:00Z", updatedAt: "2026-10-22T02:00:00Z", editVersion: 1,
    status: "pending_approval", contentHash: HASH, submittedAt: "2026-10-22T02:00:00Z", signedAt: null, currentRequestId: "req_1", receipts: [],
    ...over,
  };
}

export function makeMe(over: Partial<Me> = {}): Me {
  return {
    id: "u-owner", vuid: "v-owner", username: "nguyen.an", firstName: "An", lastName: "Nguyễn", displayName: "Nguyễn An",
    tiers: ["viewer", "director", "owner"], realmRoles: ["sg_viewer", "sg_director", "sg_owner"], isRealmAdmin: true,
    canEncrypt: false, canDecrypt: true, resourceGroups: ["general"],
    ...over,
  };
}
