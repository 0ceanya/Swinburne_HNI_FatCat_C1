import { BOARD_ROLE } from "../domain/tier.js";
import { buildDataToVerify, wrapUnsigned, type PolicyFields } from "./policyBytes.js";

/** Built into every ORK: "at least `threshold` approvers holding realm role `role`". No deployment needed. */
export const THRESHOLD_CONTRACT = "GenericRealmAccessThresholdRole:1";
/** The request models a vault policy governs: putting a key in (seal) and taking it out (release). */
export const ENCRYPTION_MODEL = "PolicyEnabledEncryption:1";
export const DECRYPTION_MODEL = "PolicyEnabledDecryption:1";
/** Every vault ciphertext carries this one tag; the browser and the server must agree on it. */
export const VAULT_TAG = "signguard-vault-v1";

/**
 * A vault policy: the Tide network will encrypt or decrypt a vault key under this policy only once
 * `threshold` distinct dokens holding the board role have approved the request (EXPLICIT approval).
 * One policy per quorum size. A realm admin signs each once, in Tide's window, under the realm's
 * admin policy; every key sealed under it is then bound to it.
 *
 * PUBLIC execution: the built-in contract has no executor check. SignGuard makes sure only the
 * requester's browser ever holds a request with the full quorum (see KeyRequest).
 */
export function vaultPolicyFields(vendorId: string, clientId: string, threshold: number): PolicyFields {
  return {
    contractId: THRESHOLD_CONTRACT,
    modelIds: [ENCRYPTION_MODEL, DECRYPTION_MODEL],
    keyId: vendorId,
    approvalType: "EXPLICIT",
    executionType: "PUBLIC",
    params: { resource: clientId, role: BOARD_ROLE, threshold },
  };
}

export const vaultPolicyKey = (threshold: number) => `quorum-${threshold}`;

export const unsignedPolicy = (f: PolicyFields) => wrapUnsigned(buildDataToVerify(f));
