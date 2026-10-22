import request from "supertest";
import { Models } from "@tideorg/js";
import { createApp } from "../../src/app.js";
import { MemoryJtiStore } from "../../src/auth/dpop.js";
import type { ServerConfig } from "../../src/config.js";
import { buildContainer } from "../../src/container.js";
import { fromBase64, toBase64 } from "../../src/lib/encoding.js";
import type { Clock, TideDirectory } from "../../src/usecases/ports.js";
import { newRealm, newUser, type FakeRealm, type TestUser } from "./fakeRealm.js";

export const ORIGIN = "http://localhost:5173";

export interface TestEnv {
  realm: FakeRealm;
  app: ReturnType<typeof createApp>;
  deps: ReturnType<typeof buildContainer>["deps"];
  store: ReturnType<typeof buildContainer>["store"];
  clock: { now(): Date; advance(ms: number): void };
  /** The demo board as it exists in the realm (roles unchanged), plus a signed-up newcomer with no roles. */
  users: { owner: TestUser; director: TestUser; accountant: TestUser; newcomer: TestUser };
  as(user: TestUser): Client;
}

export interface Client {
  get(path: string): Promise<request.Response>;
  post(path: string, body?: unknown): Promise<request.Response>;
}

export async function makeEnv(opts: { boardSize?: number; directory?: TideDirectory } = {}): Promise<TestEnv> {
  const realm = await newRealm();
  let offset = 0;
  const clock: Clock & { advance(ms: number): void } = { now: () => new Date(Date.now() + offset), advance: (ms) => { offset += ms; } };
  const cfg: ServerConfig = {
    port: 0, dbPath: ":memory:", adapter: realm.adapter, adapterPath: "(test)",
    vendorId: String(realm.adapter.vendorId), clientId: realm.clientId, realm: "signguard",
    authServerUrl: "http://localhost:8081", realmKeys: realm.realmKeys, allowedOrigins: [ORIGIN],
    org: { name: "Công ty Thử nghiệm", taxCode: "0311111111" }, boardSize: opts.boardSize ?? 3,
    requireDpop: true, admin: null, tideConsoleUrl: "http://localhost:8081/realms/signguard/tide-console/",
  };
  const { deps, auth, store } = buildContainer(cfg, { clock, directory: opts.directory });
  // DPoP freshness uses the real clock in proofs, so keep the verifier on real time too.
  auth.dpop = { ...auth.dpop, jtiStore: new MemoryJtiStore(), now: () => Date.now() / 1000 };
  const app = createApp(deps, auth);

  // Same roles as tidecloak/bootstrap.py gives the demo people. Every board member holds sg_viewer.
  const users = {
    owner: await newUser("Nguyễn An", ["sg_owner", "sg_director", "sg_viewer", "_tide_decryptor"], { realmAdmin: true }),
    director: await newUser("Lê Cường", ["sg_director", "sg_viewer", "_tide_decryptor"]),
    accountant: await newUser("Trần Bình", ["sg_drafter", "sg_viewer", "_tide_decryptor", "_tide_encryptor"]),
    newcomer: await newUser("Phạm Hoa", []),
  };

  const as = (user: TestUser): Client => {
    // Every call gets a fresh token and a fresh DPoP proof from the user's own device key.
    const send = async (method: "get" | "post", path: string, body?: unknown) => {
      const url = `/api${path}`;
      const token = await realm.token(user);
      const proof = await user.device.proof(method.toUpperCase(), `${ORIGIN}${url.split("?")[0]}`, token);
      const test = request(app)[method](url).set("Authorization", `DPoP ${token}`).set("DPoP", proof);
      return body === undefined ? test : test.send(body as object);
    };
    return { get: (p) => send("get", p), post: (p, b) => send("post", p, b ?? {}) };
  };

  return { realm, app, deps, store, clock, users, as };
}

/** The owner (a realm admin) signs every vault policy, one per quorum size, as Tide setup does. */
export async function completeTideSetup(env: TestEnv): Promise<void> {
  const setup = await env.as(env.users.owner).get("/tide/setup");
  if (setup.status !== 200) throw new Error(`setup status ${setup.status}: ${JSON.stringify(setup.body)}`);
  for (const p of setup.body.policies) {
    const signature = await env.realm.signPolicy(p.unsigned);
    const res = await env.as(env.users.owner).post(`/tide/vault-policies/${p.threshold}`, { signature });
    if (res.status !== 200 || !res.body.signatureVerified) throw new Error(`policy ${p.threshold}: ${JSON.stringify(res.body)}`);
  }
}

/** What the requester's browser does with the finish kit: add each approval to its own, like BaseTideRequest.addApproval. */
export function mergeApprovals(ownB64: string, approvals: { doken: string; signature: string }[]): string {
  const req = (Models as any).BaseTideRequest.decode(fromBase64(ownB64));
  for (const a of approvals) req.addApproval({ serialize: () => a.doken }, fromBase64(a.signature));
  return toBase64(new Uint8Array(req.encode()));
}
