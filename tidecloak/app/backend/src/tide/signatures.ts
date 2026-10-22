import { webcrypto } from "node:crypto";
import { compactVerify, importJWK, type JWK } from "jose";

/** The realm's public keys, from the adapter's embedded `jwk` (never the OIDC certs endpoint). */
export type RealmKeys = JWK[];

const ed25519Keys = (keys: RealmKeys) => keys.filter((k) => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string");

/**
 * Whether `signature` is the realm's Ed25519 signature over `message`. Never throws: anything it
 * cannot check (bad key, wrong length, malformed input) is "not signed".
 */
export async function verifyRealmSignature(keys: RealmKeys, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  for (const jwk of ed25519Keys(keys)) {
    try {
      const key = await webcrypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
      if (await webcrypto.subtle.verify({ name: "Ed25519" }, key, signature, message)) return true;
    } catch {
      // Not this key.
    }
  }
  return false;
}

/** A Tide doken (delegated token) payload, as far as SignGuard reads it. */
export interface DokenClaims {
  vuid: string;
  exp: number;
  aud: string;
  realmRoles: string[];
}

/** Parse a doken's payload without trusting it. Returns null for anything that is not a doken. */
export function parseDoken(doken: string): DokenClaims | null {
  const parts = doken.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (header?.typ !== "doken") return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof payload?.vuid !== "string" || typeof payload?.exp !== "number") return null;
    const roles = Array.isArray(payload?.realm_access?.roles) ? payload.realm_access.roles.map(String) : [];
    return { vuid: payload.vuid, exp: payload.exp, aud: String(payload.aud ?? ""), realmRoles: roles };
  } catch {
    return null;
  }
}

/** Whether a doken carries a valid realm signature (EdDSA, compact JWS). */
export async function verifyDoken(keys: RealmKeys, doken: string): Promise<boolean> {
  for (const jwk of ed25519Keys(keys)) {
    try {
      await compactVerify(doken, await importJWK({ ...jwk, alg: "EdDSA" }, "EdDSA"), { algorithms: ["EdDSA", "Ed25519"] });
      return true;
    } catch {
      // Not this key, or not signed by the realm.
    }
  }
  return false;
}
