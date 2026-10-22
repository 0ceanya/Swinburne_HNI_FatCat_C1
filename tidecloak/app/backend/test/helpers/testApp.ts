import request from "supertest";
import { createApp } from "../../src/app.js";
import { MemoryJtiStore } from "../../src/auth/dpop.js";
import type { ServerConfig } from "../../src/config.js";
import { buildContainer } from "../../src/container.js";
import type { Clock, TideDirectory } from "../../src/usecases/ports.js";
import { newRealm, newUser, type FakeRealm, type TestUser } from "./fakeRealm.js";

export const ORIGIN = "http://localhost:5173";

export interface TestEnv {
  realm: FakeRealm;
  app: ReturnType<typeof createApp>;
  deps: ReturnType<typeof buildContainer>["deps"];
  store: ReturnType<typeof buildContainer>["store"];
  clock: { now(): Date; advance(ms: number): void };
  users: {
    owner: TestUser; director: TestUser; accountant: TestUser; accountant2: TestUser; viewer: TestUser; outsider: TestUser;
  };
  as(user: TestUser): Client;
}

export interface Client {
  get(path: string): Promise<request.Response>;
  post(path: string, body?: unknown): Promise<request.Response>;
  patch(path: string, body?: unknown): Promise<request.Response>;
}

export async function makeEnv(opts: { allowUnsignedDev?: boolean; allowPlaintextDev?: boolean; directory?: TideDirectory } = {}): Promise<TestEnv> {
  const realm = await newRealm();
  let offset = 0;
  const clock: Clock & { advance(ms: number): void } = { now: () => new Date(Date.now() + offset), advance: (ms) => { offset += ms; } };
  const cfg: ServerConfig = {
    port: 0, dbPath: ":memory:", caKeyPath: "", adapter: realm.adapter, adapterPath: "(test)",
    vendorId: String(realm.adapter.vendorId), clientId: realm.clientId, realm: "signguard",
    authServerUrl: "http://localhost:8081", realmKeys: realm.realmKeys, allowedOrigins: [ORIGIN],
    org: { name: "Công ty Thử nghiệm", taxCode: "0311111111" },
    allowUnsignedDev: opts.allowUnsignedDev ?? false, allowPlaintextDev: opts.allowPlaintextDev ?? true,
    requireDpop: true, admin: null, tideConsoleUrl: "http://localhost:8081/realms/signguard/tide-console/",
  };
  const { deps, auth, store } = buildContainer(cfg, { clock, caKeyPath: null, directory: opts.directory });
  // DPoP freshness uses the real clock in proofs, so keep the verifier on real time too.
  auth.dpop = { ...auth.dpop, jtiStore: new MemoryJtiStore(), now: () => Date.now() / 1000 };
  const app = createApp(deps, auth);

  const users = {
    // The owner also holds director, so the network (which counts sg_director) can count them.
    owner: await newUser("Nguyễn An", ["sg_owner", "sg_director", "sg_viewer"], { realmAdmin: true }),
    director: await newUser("Lê Cường", ["sg_director", "sg_viewer"]),
    accountant: await newUser("Trần Bình", ["sg_drafter", "sg_viewer"]),
    accountant2: await newUser("Phạm Dung", ["sg_drafter", "sg_viewer"]),
    viewer: await newUser("Võ Em", ["sg_viewer"]),
    outsider: await newUser("Đỗ Giang", []),
  };

  const as = (user: TestUser): Client => {
    // Every call gets a fresh token and a fresh DPoP proof from the user's own device key.
    const send = async (method: "get" | "post" | "patch", path: string, body?: unknown) => {
      const url = `/api${path}`;
      const token = await realm.token(user);
      const proof = await user.device.proof(method.toUpperCase(), `${ORIGIN}${url.split("?")[0]}`, token);
      const test = request(app)[method](url).set("Authorization", `DPoP ${token}`).set("DPoP", proof);
      return body === undefined ? test : test.send(body as object);
    };
    return { get: (p) => send("get", p), post: (p, b) => send("post", p, b ?? {}), patch: (p, b) => send("patch", p, b ?? {}) };
  };

  return { realm, app, deps, store, clock, users, as };
}

/** Sign every network rule of the active policy and the sealed-fields policy, as a realm admin would. */
export async function completeTideSetup(env: TestEnv): Promise<void> {
  const setup = await env.as(env.users.owner).get("/tide/setup");
  if (setup.status !== 200) throw new Error(`setup status ${setup.status}: ${JSON.stringify(setup.body)}`);
  for (const rule of setup.body.rules) {
    const signature = await env.realm.signPolicy(rule.unsigned);
    const res = await env.as(env.users.owner).post(`/tide/rules/${rule.policyVersion}/${rule.ruleId}`, { signature });
    if (res.status !== 200 || !res.body.signatureVerified) throw new Error(`rule ${rule.ruleId}: ${JSON.stringify(res.body)}`);
  }
  const sealedSig = await env.realm.signPolicy(setup.body.sealedFields.unsigned);
  const res = await env.as(env.users.owner).post("/tide/sealed-fields", { signature: sealedSig });
  if (res.status !== 200) throw new Error(`sealed: ${JSON.stringify(res.body)}`);
}

export const sealedValues = (counterparty = "Công ty TNHH Minh Phát") => ({
  counterparty: `ct:${Buffer.from(counterparty).toString("base64")}`,
  bankAccount: "ct:VkNCIDAwMTEwMDQ4MjE=",
  description: "ct:VGhhbmggdG/DoW4gaOG7o3AgxJHhu5NuZw==",
});
