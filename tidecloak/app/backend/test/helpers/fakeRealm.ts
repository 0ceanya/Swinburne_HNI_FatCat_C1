import { randomBytes, randomUUID, webcrypto, createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey as JoseKey } from "jose";
import { container, entries, getValue, tryGetValue, utf8 } from "../../src/lib/tideMemory.js";
import { fromBase64, toBase64 } from "../../src/lib/encoding.js";
import { parsePolicy } from "../../src/tide/policyBytes.js";
import { verifyDoken, verifyRealmSignature, parseDoken } from "../../src/tide/signatures.js";
import { VAULT_TAG } from "../../src/tide/vaultPolicies.js";

/**
 * A stand-in for a TideCloak realm and the Tide network, with REAL cryptography:
 *  - an Ed25519 realm key that signs access tokens, dokens and statements (like the VVK),
 *  - an adapter config shaped like tidecloak.json,
 *  - request bytes in the exact BaseTideRequest layout (cross-checked against @tideorg/js).
 *  - a small Tide network for the vault: drafts encryption/decryption requests in the SDK's layout and,
 *    on commit, enforces the signed policy's threshold over the approvers' dokens before it seals or
 *    decrypts anything.
 * Nothing in the server is mocked: it verifies these exactly as it verifies the real thing.
 */
export interface FakeRealm {
  adapter: Record<string, unknown>;
  realmKeys: JWK[];
  issuer: string;
  clientId: string;
  token(user: TestUser, opts?: { exp?: number; azp?: string; iss?: string; jkt?: string | null; omitVuid?: boolean }): Promise<string>;
  doken(user: TestUser, opts?: { exp?: number; roles?: string[] }): Promise<string>;
  /** What the approval enclave returns: the request plus this user's doken and approval signature. */
  approve(requestB64: string, doken: string): string;
  /** The network's threshold signature over a policy's dataToVerify. */
  signPolicy(unsignedPolicyB64: string): Promise<string>;
  vault: FakeVaultNetwork;
}

/**
 * The parts of the Tide network the vault uses. `draft*` is what the browser SDK's
 * doDraftEncryption / doDraftDecryption return (initialised, no approvals); `commit` is
 * doCommitEncryption / doCommitDecryption with the merged approvals and the signed policy.
 */
export interface FakeVaultNetwork {
  draftSeal(secret: string, opts?: { tag?: string; expirySeconds?: number }): string;
  draftRelease(ciphertextB64: string, opts?: { tag?: string }): string;
  commit(requestB64: string, signedPolicyB64: string): Promise<{ ciphertext?: string; plaintext?: string }>;
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

const int64LE = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n), true);
  return b;
};
const uint32LE = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);

/** PolicyProtectedSerializedField v2: [version, encFieldChk, timestamp, encKey, signature]. */
export const sealedField = (encFieldChk: Uint8Array, timestamp: Uint8Array, encKey: Uint8Array, signature: Uint8Array) =>
  container([new Uint8Array([2]), encFieldChk, timestamp, encKey, signature]);

/** BaseTideRequest.encode(), initialised by the network (creation time + signature), no approvals. */
function initialisedRequest(name: string, draft: Uint8Array, authorizerCert: Uint8Array, expirySeconds: number) {
  const authorization = container([container([uint32LE(nowS()), randomBytes(64)]), new Uint8Array(0)]);
  return container([
    utf8(name), utf8("1"), int64LE(nowS() + expirySeconds), draft, utf8("Policy:1"),
    new Uint8Array(0), new Uint8Array(0), authorization, authorizerCert, new Uint8Array(0),
  ]);
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
    vault: fakeVaultNetwork([pub], signRaw),
  };
}

function fakeVaultNetwork(realmKeys: JWK[], signRaw: (m: Uint8Array) => Promise<Uint8Array>): FakeVaultNetwork {
  // What only the network can do: turn a C1 point back into the value (here, a lookup).
  const secrets = new Map<string, string>();
  return {
    draftSeal: (secret, o = {}) => {
      const c1 = randomBytes(32);
      const timestamp = int64LE(nowS());
      secrets.set(hex(c1), secret);
      const encFieldChk = new Uint8Array([...c1, ...randomBytes(Math.max(secret.length, 1))]);
      const draft = container([timestamp, container([c1, randomBytes(32), utf8(o.tag ?? VAULT_TAG)])]);
      const heavy = container([sealedField(encFieldChk, timestamp, new Uint8Array(0), new Uint8Array(0))]);
      return toBase64(initialisedRequest("PolicyEnabledEncryption", draft, heavy, o.expirySeconds ?? 7 * 24 * 3600));
    },
    draftRelease: (ciphertextB64, o = {}) => {
      const field = fromBase64(ciphertextB64);
      const encFieldChk = getValue(field, 1);
      const timestamp = getValue(field, 2);
      const encKey = getValue(field, 3);
      const signature = getValue(field, 4);
      const c1 = (encKey.length ? encKey : encFieldChk).subarray(0, 32);
      const draft = container([container([c1, signature, timestamp, utf8(o.tag ?? VAULT_TAG)])]);
      const heavy = container([container([encFieldChk, encKey])]);
      return toBase64(initialisedRequest("PolicyEnabledDecryption", draft, heavy, 7 * 24 * 3600));
    },
    commit: async (requestB64, signedPolicyB64) => {
      const req = fromBase64(requestB64);
      const name = Buffer.from(getValue(req, 0)).toString();
      const policy = parsePolicy(fromBase64(signedPolicyB64));
      if (!policy.signature || !(await verifyRealmSignature(realmKeys, policy.signature, policy.dataToVerify))) throw new Error("policy is not signed by the realm");
      if (!policy.modelIds.includes(`${name}:1`)) throw new Error(`policy does not cover ${name}`);
      if (policy.approvalType !== "EXPLICIT") throw new Error("expected an EXPLICIT policy");
      const authorizer = getValue(req, 6);
      const dokens = authorizer.length >= 4 ? entries(authorizer).map((d) => Buffer.from(d).toString()) : [];
      const sigSection = tryGetValue(getValue(req, 7), 1);
      const sigs = sigSection ? entries(sigSection).filter((x) => x.length > 0) : [];
      if (sigs.length !== dokens.length) throw new Error("approvals and approval signatures do not line up");
      // Like GenericRealmAccessThresholdRole:1 in the SDK: count dokens holding the role.
      let holders = 0;
      for (const d of dokens) {
        const claims = parseDoken(d);
        if (claims && claims.exp > nowS() && claims.realmRoles.includes(String(policy.params.role)) && (await verifyDoken(realmKeys, d))) holders++;
      }
      if (holders < Number(policy.params.threshold)) throw new Error(`THRESHOLD_FAILURE: ${holders} of ${policy.params.threshold} approvals`);
      const draft = getValue(req, 3);
      if (name === "PolicyEnabledEncryption") {
        const timestamp = getValue(draft, 0);
        const entry = getValue(draft, 1);
        const c1 = getValue(entry, 0);
        const stored = getValue(getValue(req, 8), 0);
        const sig = await signRaw(new Uint8Array([...c1, ...timestamp]));
        return { ciphertext: toBase64(sealedField(getValue(stored, 1), timestamp, getValue(stored, 3), sig)) };
      }
      const c1 = getValue(getValue(draft, 0), 0);
      const secret = secrets.get(hex(c1));
      if (secret === undefined) throw new Error("unknown ciphertext");
      return { plaintext: secret };
    },
  };
}
