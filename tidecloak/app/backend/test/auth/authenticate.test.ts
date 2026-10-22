import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { AuthError, authenticate, type AuthOptions } from "../../src/auth/authenticate.js";
import { MemoryJtiStore } from "../../src/auth/dpop.js";
import { newDevice, newRealm, newUser } from "../helpers/fakeRealm.js";

const ORIGIN = "http://localhost:5173";
const PATH = "/api/me";

async function setup() {
  const realm = await newRealm();
  const user = await newUser("Lê Cường", ["sg_director", "sg_viewer"]);
  const opts: AuthOptions = { adapter: realm.adapter, requireDpop: true, dpop: { allowedOrigins: [ORIGIN], jtiStore: new MemoryJtiStore() } };
  const call = async (token: string, proof: string | undefined, scheme = "DPoP", path = PATH, method = "GET") =>
    authenticate({ method, path, authorization: `${scheme} ${token}`, dpop: proof }, opts);
  return { realm, user, opts, call };
}

const rejects = async (p: Promise<unknown>, pattern: RegExp) => {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AuthError);
  expect(String((err as Error).message)).toMatch(pattern);
};

describe("authenticate: Tide token + DPoP", () => {
  it("accepts a valid token with a fresh proof from the bound device, and reads the tiers", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    const p = await call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, token));
    expect(p.vuid).toBe(user.vuid);
    expect(p.tiers).toEqual(["viewer", "director"]);
    expect(p.deviceKey).toBe(user.device.jkt);
  });

  it("rejects a bound token presented as Bearer (a stolen-token replay)", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    await rejects(call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, token), "Bearer"), /DPoP scheme/);
  });

  it("rejects a missing proof", async () => {
    const { realm, user, call } = await setup();
    await rejects(call(await realm.token(user), undefined), /Missing DPoP proof/);
  });

  it("rejects a proof from a different device", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    const thief = await newDevice();
    await rejects(call(token, await thief.proof("GET", `${ORIGIN}${PATH}`, token)), /cnf\.jkt/);
  });

  it("rejects a proof replayed (same jti)", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    const proof = await user.device.proof("GET", `${ORIGIN}${PATH}`, token, { jti: "fixed" });
    await call(token, proof);
    await rejects(call(token, proof), /replay/);
  });

  it("rejects a proof made for another URL, method, or token", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    await rejects(call(token, await user.device.proof("GET", `${ORIGIN}/api/audit`, token)), /htu/);
    await rejects(call(token, await user.device.proof("POST", `${ORIGIN}${PATH}`, token)), /htm/);
    const other = await realm.token(user);
    await rejects(call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, other)), /ath/);
    await rejects(call(token, await user.device.proof("GET", `http://evil.example${PATH}`, token)), /htu/);
  });

  it("rejects a stale proof", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user);
    await rejects(call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, token, { iat: Math.floor(Date.now() / 1000) - 3600 })), /iat/);
  });

  it("rejects an expired token, the wrong client, the wrong issuer", async () => {
    const { realm, user, call } = await setup();
    for (const token of [
      await realm.token(user, { exp: Math.floor(Date.now() / 1000) - 60 }),
      await realm.token(user, { azp: "another-client" }),
      await realm.token(user, { iss: "http://localhost:8081/realms/other" }),
    ]) {
      await rejects(call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, token)), /not valid/);
    }
  });

  it("rejects a token signed by any key other than the realm's", async () => {
    const { user, call } = await setup();
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ vuid: user.vuid, azp: "signguard-client", realm_access: { roles: ["sg_owner"] }, cnf: { jkt: user.device.jkt } })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-vvk" }).setSubject(user.sub).setIssuer("http://localhost:8081/realms/signguard")
      .setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await rejects(call(forged, await user.device.proof("GET", `${ORIGIN}${PATH}`, forged)), /not valid/);
  });

  it("rejects a token without a Tide vuid", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user, { omitVuid: true });
    await rejects(call(token, await user.device.proof("GET", `${ORIGIN}${PATH}`, token)), /vuid/);
  });

  it("rejects an unbound token when DPoP is required", async () => {
    const { realm, user, call } = await setup();
    const token = await realm.token(user, { jkt: null });
    await rejects(call(token, undefined, "Bearer"), /sender-constrained/);
  });

  it("rejects a request with no Authorization header", async () => {
    const { opts } = await setup();
    await rejects(authenticate({ method: "GET", path: PATH, authorization: undefined, dpop: undefined }, opts), /Sign in/);
  });
});
