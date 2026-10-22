import type { KeyRequest, Me, ServerConfig, VaultKey } from "@/api/types";

export function makeKey(over: Partial<VaultKey> = {}): VaultKey {
  return {
    id: "key_1", name: "AWS root", kind: "cloud_root", provider: "AWS", description: "Production account root", hint: "••••ROOT",
    level: 4, quorum: 3, status: "active", ciphertext: "Q0lQSEVSVEVYVA==", createdBy: { id: "u-owner", name: "Nguyễn An" },
    createdAt: "2026-10-22T01:00:00Z", sealedAt: "2026-10-22T01:30:00Z", sealRequestId: "req_0", releaseCount: 0, lastReleasedAt: null, lastReleasedTo: null,
    ...over,
  };
}

export function makeRequest(over: Partial<KeyRequest> = {}): KeyRequest {
  return {
    id: "req_1", keyId: "key_1", keyName: "AWS root", keyLevel: 4, operation: "release", quorum: 3, othersNeeded: 2,
    requester: { memberId: "u-acct", name: "Trần Bình" }, reason: "Close the old billing account", status: "collecting",
    tideRequest: "UkVRVUVTVA==",
    approvals: [{ memberId: "u-dir", name: "Lê Cường", at: "2026-10-22T03:00:00Z", dokenVerified: true }],
    rejection: null, createdAt: "2026-10-22T02:00:00Z", expiresAt: "2026-10-25T02:00:00Z", closedAt: null, closedReason: null, finishedWith: null,
    ...over,
  };
}

export function makeMe(over: Partial<Me> = {}): Me {
  return {
    id: "u-owner", vuid: "v-owner", username: "owner", firstName: "An", lastName: "Nguyễn Văn", displayName: "Nguyễn Văn An",
    tiers: ["viewer", "director", "owner"], realmRoles: ["sg_viewer", "sg_director", "sg_owner"], onBoard: true, isRealmAdmin: true,
    ...over,
  };
}

export const config: ServerConfig = {
  org: { name: "Công ty Thử nghiệm", taxCode: "0311111111" }, tideConsoleUrl: "", boardSize: 3, tag: "signguard-vault-v1",
  kinds: [
    { id: "cloud_root", label: "Cloud root credential", defaultLevel: 4, examples: "AWS root" },
    { id: "digital_signature", label: "Digital signature (chữ ký số)", defaultLevel: 3, examples: "Viettel MySign" },
    { id: "api_key", label: "API key", defaultLevel: 2, examples: "Stripe" },
  ],
  levels: [{ level: 1, label: "Standard", quorum: 1 }, { level: 2, label: "Elevated", quorum: 2 }, { level: 3, label: "High", quorum: 3 }, { level: 4, label: "Critical", quorum: 3 }],
};
