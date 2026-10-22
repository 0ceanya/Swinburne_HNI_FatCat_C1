import { randomBytes, randomUUID, webcrypto, createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey as JoseKey } from "jose";
import { container, entries, getValue, tryGetValue, utf8 } from "../../src/lib/tideMemory.js";
import { fromBase64, toBase64 } from "../../src/lib/encoding.js";
import { parsePolicy } from "../../src/tide/policyBytes.js";

/**
 * A stand-in for a TideCloak realm and the Tide network, with REAL cryptography:
 *  - an Ed25519 realm key that signs access tokens, dokens and statements (like the VVK),
 *  - an adapter config shaped like tidecloak.json,
 *  - request bytes in the exact BaseTideRequest layout (cross-checked against @tideorg/js).
 * Nothing in the server is mocked: it verifies these exactly as it verifies the real thing.
 */
export interface FakeRealm {
  adapter: Record<string, unknown>;
  realmKeys: JWK[];
  issuer: string;
  clientId: string;
  token(user: TestUser, opts?: { exp?: number; azp?: string; iss?: string; jkt?: string | null; omitVuid?: boolean }): Promise<string>;
  doken(user: TestUser, opts?: { exp?: number; roles?: string[] }): Promise<string>;
  /** What the network returns from createTideRequest for a "sign this policy" request. */
  initRequest(unsignedPolicyB64: string, expirySeconds?: number): string;
  /** What the approval enclave returns: the request plus this user's doken and approval signature. */
  approve(requestB64: string, doken: string): string;
  /** The network's threshold signature over a policy's dataToVerify. */
  signPolicy(unsignedPolicyB64: string): Promise<string>;
  signBytes(message: Uint8Array): Promise<string>;
}

export interface TestUser {
  sub: string;
  vuid: string;
  username: string;
  firstName: string;
  lastName: string;
  roles: string[];
  realmAdmin?: boolean;
  device: Device;
}

export interface Device {
  jkt: string;
  proof(method: string, url: string, accessToken: string, opts?: { iat?: number; jti?: string }): Promise<string>;
}

export async function newDevice(): Promise<Device> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const { calculateJwkThumbprint } = await import("jose");
  const jkt = await calculateJwkThumbprint(jwk, "sha256");
  return {
    jkt,
    proof: async (method, url, accessToken, opts = {}) =>
      new SignJWT({
        jti: opts.jti ?? randomUUID(), htm: method, htu: url, iat: opts.iat ?? Math.floor(Date.now() / 1000),
        ath: createHash("sha256").update(accessToken).digest("base64url"),
      }).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk }).sign(privateKey),
  };
}

export async function newUser(name: string, roles: string[], opts: { realmAdmin?: boolean } = {}): Promise<TestUser> {
  const [lastName, firstName] = name.split(" ");
  return {
    sub: randomUUID(), vuid: randomBytes(32).toString("hex"), username: name.toLowerCase().replace(/\s+/g, "."),
    firstName: firstName ?? name, lastName: lastName ?? "", roles: ["appUser", "_tide_enabled", ...roles],
    realmAdmin: opts.realmAdmin, device: await newDevice(),
  };
}

export async function newRealm(): Promise<FakeRealm> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: "test-vvk", alg: "EdDSA", use: "sig" };
  const issuer = "http://localhost:8081/realms/signguard";
  const clientId = "signguard-client";
  const adapter = {
    realm: "signguard", "auth-server-url": "http://localhost:8081/", resource: clientId, "public-client": true,
    vendorId: "test-vendor-id", homeOrkUrl: "https://ork.test", jwk: { keys: [pub] },
  };
  const signRaw = async (message: Uint8Array) =>
    new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey as unknown as webcrypto.CryptoKey, message));

  return {
    adapter, realmKeys: [pub], issuer, clientId,
    token: async (u, o = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        ...(o.omitVuid ? {} : { vuid: u.vuid }), tideuserkey: "tuk-" + u.vuid.slice(0, 8), preferred_username: u.username,
        given_name: u.firstName, family_name: u.lastName, azp: o.azp ?? clientId, typ: "Bearer",
        realm_access: { roles: u.roles },
        resource_access: u.realmAdmin ? { "realm-management": { roles: ["tide-realm-admin", "realm-admin"] } } : {},
        ...(o.jkt === null ? {} : { cnf: { jkt: o.jkt ?? u.device.jkt } }),
      }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-vvk" })
        .setSubject(u.sub).setIssuer(o.iss ?? issuer).setIssuedAt(now).setExpirationTime(o.exp ?? now + 300).setJti(randomUUID())
        .sign(privateKey as JoseKey);
    },
    doken: async (u, o = {}) =>
      new SignJWT({ vuid: u.vuid, exp: o.exp ?? Math.floor(Date.now() / 1000) + 600, aud: clientId,
        realm_access: { roles: o.roles ?? u.roles }, "t.ssk": "x", tideuserkey: "y", "t.uho": "https://ork.test" })
        .setProtectedHeader({ alg: "EdDSA", typ: "doken" }).sign(privateKey as JoseKey),
    initRequest: (unsigned, expirySeconds = 7 * 24 * 3600) => {
      const expiry = new Uint8Array(8);
      new DataView(expiry.buffer).setBigInt64(0, BigInt(Math.floor(Date.now() / 1000) + expirySeconds), true);
      const creationTime = new Uint8Array(8);
      new DataView(creationTime.buffer).setBigInt64(0, BigInt(Math.floor(Date.now() / 1000)), true);
      const authorization = container([container([creationTime, randomBytes(64)]), new Uint8Array(0)]);
      return toBase64(container([
        utf8("Policy"), utf8("1"), expiry, container([fromBase64(unsigned)]), utf8("Policy:1"),
        new Uint8Array(0), new Uint8Array(0), authorization, new Uint8Array(0), new Uint8Array(0),
      ]));
    },
    approve: (requestB64, doken) => {
      const bytes = fromBase64(requestB64);
      const fields = entries(bytes);
      while (fields.length < 10) fields.push(new Uint8Array(0));
      const authorizer = fields[6]!;
      const authorization = fields[7]!;
      const dokens = authorizer.length >= 4 ? entries(authorizer) : [];
      const sigSection = tryGetValue(authorization, 1);
      const sigs = sigSection ? entries(sigSection) : [];
      fields[6] = container([...dokens, utf8(doken)]);
      fields[7] = container([getValue(authorization, 0), container([...sigs, randomBytes(64)])]);
      return toBase64(container(fields));
    },
    signPolicy: async (unsigned) => toBase64(await signRaw(parsePolicy(fromBase64(unsigned)).dataToVerify)),
    signBytes: async (m) => toBase64(await signRaw(m)),
  };
}
