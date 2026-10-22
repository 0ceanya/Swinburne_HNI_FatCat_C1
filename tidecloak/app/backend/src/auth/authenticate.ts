import { verifyTideCloakToken } from "@tidecloak/verify";
import { tiersFromRoles, DECRYPT_ROLE, ENCRYPT_ROLE } from "../domain/tier.js";
import type { Principal } from "../usecases/context.js";
import { DpopError, verifyDpop, type DpopOptions } from "./dpop.js";

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 = 401) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthOptions {
  /** The TideCloak adapter config (tidecloak.json): its embedded `jwk`, realm, client and issuer. */
  adapter: Record<string, unknown>;
  /** DPoP is required on every request unless explicitly disabled (tests of the Bearer path only). */
  requireDpop: boolean;
  dpop: DpopOptions;
}

export interface IncomingAuth {
  method: string;
  path: string;
  authorization: string | undefined;
  dpop: string | undefined;
}

type Claims = Record<string, unknown> & {
  sub?: string; vuid?: string; tideuserkey?: string; preferred_username?: string;
  given_name?: string; family_name?: string; cnf?: { jkt?: string };
  realm_access?: { roles?: string[] }; resource_access?: Record<string, { roles?: string[] }>;
};

/**
 * Verify the access token (signature against the realm's embedded key, issuer, client, expiry) and
 * the DPoP proof binding it to the caller's device. Every protected route goes through this.
 */
export async function authenticate(req: IncomingAuth, opts: AuthOptions): Promise<Principal> {
  const match = /^(Bearer|DPoP) (.+)$/i.exec(req.authorization ?? "");
  if (!match) throw new AuthError("Sign in required");
  const token = match[2]!;

  const claims = (await verifyTideCloakToken(opts.adapter, token, [])) as Claims | null;
  if (!claims) throw new AuthError("Your session is not valid. Sign in again.");

  let deviceKey: string | null = null;
  if (opts.requireDpop || claims.cnf?.jkt) {
    try {
      deviceKey = await verifyDpop({ method: req.method, path: req.path, authorization: req.authorization, proof: req.dpop }, token, claims, opts.dpop);
    } catch (e) {
      throw new AuthError(e instanceof DpopError ? `Device check failed: ${e.message}` : "Device check failed");
    }
  }

  if (typeof claims.sub !== "string" || typeof claims.vuid !== "string" || !claims.vuid) {
    throw new AuthError("This token has no Tide identity (vuid). Is the Tide vuid mapper on the client?", 403);
  }
  const realmRoles = claims.realm_access?.roles ?? [];
  const rm = claims.resource_access?.["realm-management"]?.roles ?? [];
  return {
    id: claims.sub,
    vuid: claims.vuid,
    username: claims.preferred_username ?? claims.vuid,
    firstName: claims.given_name ?? "",
    lastName: claims.family_name ?? "",
    tiers: tiersFromRoles(realmRoles),
    realmRoles,
    isRealmAdmin: rm.includes("tide-realm-admin"),
    canEncrypt: realmRoles.includes(ENCRYPT_ROLE),
    canDecrypt: realmRoles.includes(DECRYPT_ROLE),
    tideUserKey: claims.tideuserkey ?? "",
    deviceKey,
  };
}
