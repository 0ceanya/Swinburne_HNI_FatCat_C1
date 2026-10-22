import { DomainError, invalid, notFound } from "../domain/errors.js";
import { fromBase64, toBase64 } from "../lib/encoding.js";
import { buildDataToVerify, parsePolicy, wrapSigned } from "../tide/policyBytes.js";
import { verifyRealmSignature } from "../tide/signatures.js";
import { unsignedPolicy, vaultPolicyFields, vaultPolicyKey } from "../tide/vaultPolicies.js";
import { actorOf, nowIso, requireBoard, requireRealmAdmin, type Deps, type Principal } from "./context.js";

/**
 * Tide setup: a realm admin signs one vault policy per quorum size (1 … board size), once each, in
 * Tide's own window, under the realm's admin policy. The server builds the unsigned bytes and checks
 * the signature that comes back.
 */
export class TideSetup {
  constructor(private d: Deps) {}

  status(p: Principal) {
    requireBoard(p);
    const keys = this.d.keys.list();
    return {
      isRealmAdmin: p.isRealmAdmin,
      directoryAvailable: this.d.directory.available,
      boardSize: this.d.settings.boardSize,
      policies: Array.from({ length: this.d.settings.boardSize }, (_, i) => i + 1).map((threshold) => {
        const stored = this.d.tidePolicies.get("vault-policy", vaultPolicyKey(threshold));
        return {
          threshold,
          signed: !!stored,
          signatureVerified: stored?.signatureVerified ?? false,
          signedBy: stored?.signedBy.name ?? null,
          signedAt: stored?.signedAt ?? null,
          keysUsing: keys.filter((k) => k.quorum === threshold && k.status !== "rejected").length,
          unsigned: toBase64(unsignedPolicy(vaultPolicyFields(this.d.tide.vendorId, this.d.tide.clientId, threshold))),
        };
      }),
    };
  }

  async adminPolicy(p: Principal): Promise<string> {
    requireRealmAdmin(p);
    if (!this.d.directory.available) throw new DomainError("DIRECTORY_UNAVAILABLE", "The server has no TideCloak admin credential configured", 409);
    return this.d.directory.adminPolicy();
  }

  async storeVaultPolicy(p: Principal, threshold: number, signatureB64: string) {
    requireRealmAdmin(p);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > this.d.settings.boardSize) throw notFound("Vault policy");
    const key = vaultPolicyKey(threshold);
    // A sealed key is bound to the exact policy it was sealed under: never replace one.
    if (this.d.tidePolicies.get("vault-policy", key)) throw new DomainError("ALREADY_SIGNED", "This policy is already signed");
    let signature: Uint8Array;
    try { signature = fromBase64(signatureB64); } catch { throw invalid("signature must be base64", "INVALID_ENCODING"); }
    if (signature.length !== 64) throw invalid("A Tide signature is 64 bytes", "INVALID_SIGNATURE");
    const dataToVerify = buildDataToVerify(vaultPolicyFields(this.d.tide.vendorId, this.d.tide.clientId, threshold));
    // The network checks the policy itself whenever it is used. We verify too and show the result.
    const signatureVerified = await verifyRealmSignature(this.d.tide.realmKeys, signature, dataToVerify);
    const signed = toBase64(wrapSigned(dataToVerify, signature));
    parsePolicy(fromBase64(signed));
    const now = nowIso(this.d);
    this.d.transaction(() => {
      this.d.tidePolicies.save({ kind: "vault-policy", key, signed, signatureVerified, signedBy: actorOf(p), signedAt: now });
      this.d.audit.append({ at: now, event: "tide.vault_policy_signed", actor: actorOf(p), keyId: null, requestId: null, details: { threshold, signatureVerified } });
    });
    return { key, signatureVerified };
  }
}
