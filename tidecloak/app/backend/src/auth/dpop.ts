import { createHash } from "node:crypto";
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

/**
 * RFC 9449 DPoP proof verification, ported from the Tide Agent Pack's templates/dpop-verify.
 *
 * The token carries `cnf.jkt` (the thumbprint of a key only the user's browser holds) and every
 * request carries a fresh proof signed by that key. Without this check a stolen token replays as a
 * plain Bearer token and succeeds; the binding would be decorative.
 */
export class DpopError extends Error {
  override name = "DpopError";
}

export interface JtiStore {
  /** true if this jti has not been seen before (and records it). */
  claim(jti: string, expiresAtMs: number): boolean;
}

/** Single-process store. Correct for one server instance only; use a shared store if you scale out. */
export class MemoryJtiStore implements JtiStore {
  private seen = new Map<string, number>();
  claim(jti: string, expiresAtMs: number): boolean {
    const now = Date.now();
    if (this.seen.size > 10_000) for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    if ((this.seen.get(jti) ?? 0) >= now) return false;
    this.seen.set(jti, expiresAtMs);
    return true;
  }
}

export interface DpopRequest {
  method: string;
  /** Path the browser requested, without the query string (the SDK signs origin + pathname). */
  path: string;
  authorization: string | undefined;
  proof: string | undefined;
}

export interface DpopOptions {
  /** Origins the browser may be on, e.g. http://localhost:5173. The proof's htu must start with one. */
  allowedOrigins: string[];
  jtiStore: JtiStore;
  iatSkewSeconds?: number;
  now?: () => number;
}

const base64url = (b: Buffer) => b.toString("base64url");

/** Throws DpopError unless the request carries a valid proof bound to this access token. Returns the key thumbprint. */
export async function verifyDpop(req: DpopRequest, accessToken: string, claims: { cnf?: { jkt?: string } }, opts: DpopOptions): Promise<string> {
  const jkt = claims.cnf?.jkt;
  if (!jkt) throw new DpopError("Access token is not sender-constrained (no cnf.jkt). Enable useDPoP on the client.");
  if (!/^DPoP /i.test(req.authorization ?? "")) throw new DpopError("A DPoP-bound token must use the DPoP scheme; as Bearer it is a replay.");
  if (!req.proof) throw new DpopError("Missing DPoP proof header.");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(req.proof);
  } catch {
    throw new DpopError("DPoP proof is not a compact JWS.");
  }
  if (header.typ !== "dpop+jwt") throw new DpopError(`DPoP proof typ is '${String(header.typ)}', expected 'dpop+jwt'.`);
  if (!["ES256", "ES384", "ES512", "EdDSA", "Ed25519"].includes(String(header.alg))) throw new DpopError("DPoP proof uses an unsupported algorithm.");
  const jwk = header.jwk as JWK | undefined;
  if (!jwk || "d" in jwk) throw new DpopError("DPoP proof must embed a public jwk.");

  let payload: Record<string, unknown>;
  try {
    // Verified with the key the proof carries, never the realm key.
    ({ payload } = (await jwtVerify(req.proof, await importJWK(jwk, header.alg), { typ: "dpop+jwt" })) as { payload: Record<string, unknown> });
  } catch (e) {
    throw new DpopError(`DPoP proof signature invalid: ${e instanceof Error ? e.message : String(e)}`);
  }

  if ((await calculateJwkThumbprint(jwk, "sha256")) !== jkt) throw new DpopError("DPoP proof key does not match the token's cnf.jkt.");
  if (payload.ath !== base64url(createHash("sha256").update(accessToken).digest())) throw new DpopError("DPoP proof ath does not match this access token.");
  if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== req.method.toUpperCase()) throw new DpopError("DPoP proof htm does not match the method.");

  const htu = typeof payload.htu === "string" ? payload.htu : "";
  if (!opts.allowedOrigins.some((origin) => htu === `${origin}${req.path}`)) {
    throw new DpopError(`DPoP proof htu '${htu}' does not match this request.`);
  }

  const now = opts.now?.() ?? Date.now() / 1000;
  const skew = opts.iatSkewSeconds ?? 300;
  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  if (!Number.isFinite(iat) || Math.abs(now - iat) > skew) throw new DpopError(`DPoP proof iat is outside the ±${skew}s window.`);
  if (typeof payload.jti !== "string" || !payload.jti) throw new DpopError("DPoP proof has no jti.");
  if (!opts.jtiStore.claim(payload.jti, (now + skew) * 1000)) throw new DpopError("DPoP proof jti already used: replay.");
  return jkt;
}
