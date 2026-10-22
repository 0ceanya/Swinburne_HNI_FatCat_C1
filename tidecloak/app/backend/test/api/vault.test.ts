import { beforeEach, describe, expect, it } from "vitest";
import { AuditEntry } from "../../src/domain/auditEntry.js";
import type { TestUser } from "../helpers/fakeRealm.js";
import { completeTideSetup, makeEnv, mergeApprovals, type TestEnv } from "../helpers/testApp.js";

let env: TestEnv;

/** The registrar's browser: encrypt the secret with Tide (draft), then ask the board to seal it. */
async function register(user: TestUser, o: { name?: string; kind?: string; level?: number; secret?: string } = {}) {
  const request = env.realm.vault.draftSeal(o.secret ?? "s3cr3t");
  return env.as(user).post("/keys", {
    name: o.name ?? "Stripe live key", kind: o.kind ?? "api_key", provider: "Stripe", description: "Payment gateway",
    hint: "••••4821", level: o.level ?? 2, request,
  });
}

async function registerOk(user: TestUser, o: Parameters<typeof register>[1] = {}) {
  const res = await register(user, o);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { key: { id: string; quorum: number; status: string }; request: { id: string; status: string } };
}

/** An approver's browser: approve the stored bytes in Tide's window, hand back the result. */
async function approve(user: TestUser, reqId: string, opts: { doken?: string } = {}) {
  const base = (await env.as(user).get(`/requests/${reqId}`)).body.request.tideRequest;
  const approved = env.realm.approve(base, opts.doken ?? (await env.realm.doken(user)));
  return env.as(user).post(`/requests/${reqId}/approve`, { request: approved });
}

/**
 * The requester's browser finishing: fetch the kit, approve in Tide (their own approval), merge
 * every approval, ask the network to seal/decrypt, then report back with their own approval.
 */
async function finish(user: TestUser, reqId: string) {
  const kit = await env.as(user).post(`/requests/${reqId}/finish-kit`);
  if (kit.status !== 200) return { res: kit, plaintext: undefined };
  const base = (await env.as(user).get(`/requests/${reqId}`)).body.request.tideRequest;
  const own = env.realm.approve(base, await env.realm.doken(user));
  const result = await env.realm.vault.commit(mergeApprovals(own, kit.body.approvals), kit.body.policy);
  const res = await env.as(user).post(`/requests/${reqId}/finish`, { request: own, ciphertext: result.ciphertext });
  return { res, plaintext: result.plaintext };
}

async function sealedKey(registrar: TestUser, approvers: TestUser[], o: Parameters<typeof register>[1] = {}) {
  const { key, request } = await registerOk(registrar, o);
  for (const a of approvers) expect((await approve(a, request.id)).status).toBe(200);
  const { res } = await finish(registrar, request.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return key.id;
}

async function askFor(user: TestUser, keyId: string, reason = "Rotate the webhook secret") {
  const key = (await env.as(user).get(`/keys/${keyId}`)).body.key;
  return env.as(user).post(`/keys/${keyId}/release`, { reason, request: env.realm.vault.draftRelease(key.ciphertext) });
}

const events = async () => ((await env.as(env.users.owner).get("/audit")).body as { event: string; actor: { name: string }; details: Record<string, unknown> }[]);

describe("before Tide setup", () => {
  beforeEach(async () => { env = await makeEnv(); });

  it("refuses to register a key until the network policy for its quorum is signed", async () => {
    const res = await register(env.users.accountant);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VAULT_POLICY_MISSING");
  });

  it("lists one vault policy per quorum size, and only a realm admin can sign them", async () => {
    const setup = await env.as(env.users.director).get("/tide/setup");
    expect(setup.body.policies.map((p: { threshold: number }) => p.threshold)).toEqual([1, 2, 3]);
    const sig = await env.realm.signPolicy(setup.body.policies[0].unsigned);
    expect((await env.as(env.users.director).post("/tide/vault-policies/1", { signature: sig })).body.error.code).toBe("NOT_REALM_ADMIN");
  });

  it("records a policy signature that does not verify and says so, and never replaces a signed policy", async () => {
    const res = await env.as(env.users.owner).post("/tide/vault-policies/2", { signature: Buffer.alloc(64, 1).toString("base64") });
    expect(res.status).toBe(200);
    expect(res.body.signatureVerified).toBe(false);
    const again = await env.as(env.users.owner).post("/tide/vault-policies/2", { signature: Buffer.alloc(64, 2).toString("base64") });
    expect(again.body.error.code).toBe("ALREADY_SIGNED");
  });

  it("rejects unauthenticated calls", async () => {
    const { default: request } = await import("supertest");
    expect((await request(env.app).get("/api/keys")).status).toBe(401);
  });
});

describe("with the vault policies signed", () => {
  beforeEach(async () => {
    env = await makeEnv();
    await completeTideSetup(env);
  });

  it("a level-2 API key needs 2 people to seal: the registrar and one other", async () => {
    const { owner, director, accountant } = env.users;
    const { key, request } = await registerOk(accountant, { level: 2 });
    expect(key.quorum).toBe(2);
    expect(key.status).toBe("pending_seal");
    expect(request.status).toBe("collecting");

    // The registrar's own approval only comes when they finish.
    const self = await approve(accountant, request.id);
    expect(self.body.error.code).toBe("REQUESTER_APPROVES_AT_FINISH");
    expect((await env.as(accountant).post(`/requests/${request.id}/finish-kit`)).body.error.code).toBe("NOT_READY");

    expect((await env.as(director).get("/requests")).body.waitingForMe.map((r: { id: string }) => r.id)).toEqual([request.id]);
    const ok = await approve(director, request.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe("ready");
    expect(ok.body.approvals[0].dokenVerified).toBe(true);
    expect(ok.body.approvals[0]).not.toHaveProperty("doken");
    expect((await approve(owner, request.id)).body.error.code).toBe("ALREADY_READY");

    // Only the requester receives the approvals.
    expect((await env.as(director).post(`/requests/${request.id}/finish-kit`)).body.error.code).toBe("NOT_REQUESTER");
    expect((await env.as(accountant).get("/requests")).body.readyToFinish.map((r: { id: string }) => r.id)).toEqual([request.id]);

    const { res } = await finish(accountant, request.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.key.status).toBe("active");
    expect(res.body.key.ciphertext).toBeTruthy();
    expect(res.body.request.status).toBe("completed");

    const log = await events();
    expect(log.map((e) => e.event)).toEqual(expect.arrayContaining(["key.registered", "request.denied_attempt", "request.approved", "request.finish_started", "key.sealed"]));
  });

  it("the network itself refuses without the quorum: one person's approval cannot seal a level-2 key", async () => {
    const { accountant } = env.users;
    const { request } = await registerOk(accountant, { level: 2 });
    const base = (await env.as(accountant).get(`/requests/${request.id}`)).body.request.tideRequest;
    const own = env.realm.approve(base, await env.realm.doken(accountant));
    const policy = env.deps.tidePolicies.get("vault-policy", "quorum-2")!.signed;
    await expect(env.realm.vault.commit(own, policy)).rejects.toThrow(/THRESHOLD_FAILURE/);
  });

  it("a level-4 cloud root key needs all 3 board members (capped at the board size), to seal and to unlock", async () => {
    const { owner, director, accountant } = env.users;
    const secret = "AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { key, request } = await registerOk(owner, { name: "AWS root", kind: "cloud_root", level: 4, secret });
    expect(key.quorum).toBe(3);
    expect((await approve(director, request.id)).body.status).toBe("collecting");
    expect((await approve(accountant, request.id)).body.status).toBe("ready");
    expect((await finish(owner, request.id)).res.status).toBe(200);

    const ask = await askFor(accountant, key.id, "Close the old billing account");
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body.operation).toBe("release");
    expect(ask.body.othersNeeded).toBe(2);
    expect((await finish(accountant, ask.body.id)).res.body.error.code).toBe("NOT_READY");
    await approve(owner, ask.body.id);
    await approve(director, ask.body.id);

    const { res, plaintext } = await finish(accountant, ask.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(plaintext).toBe(secret);
    expect(res.body.key.releaseCount).toBe(1);
    expect(res.body.key.lastReleasedTo.name).toBe("Trần Bình");
    const log = await events();
    const released = log.find((e) => e.event === "release.completed")!;
    expect(released.actor.name).toBe("Trần Bình");
    expect(released.details.approvedBy).toEqual(["Nguyễn An", "Lê Cường"]);
  });

  it("a level-1 key: the requester alone seals and unlocks it, and it is logged", async () => {
    const { director } = env.users;
    const { key, request } = await registerOk(director, { kind: "other", level: 1, secret: "wifi-pass" });
    expect(request.status).toBe("ready");
    expect((await finish(director, request.id)).res.status).toBe(200);
    const ask = await askFor(director, key.id);
    expect(ask.body.status).toBe("ready");
    const { plaintext } = await finish(director, ask.body.id);
    expect(plaintext).toBe("wifi-pass");
  });

  it("an approval must be the caller's own, exactly one, on the stored bytes, from a board member", async () => {
    const { owner, director, accountant, newcomer } = env.users;
    const { request } = await registerOk(accountant, { level: 3 });
    const base = (await env.as(director).get(`/requests/${request.id}`)).body.request.tideRequest;

    const someoneElses = await approve(director, request.id, { doken: await env.realm.doken(owner) });
    expect(someoneElses.body.error.code).toBe("APPROVER_MISMATCH");

    const two = env.realm.approve(env.realm.approve(base, await env.realm.doken(director)), await env.realm.doken(director));
    expect((await env.as(director).post(`/requests/${request.id}/approve`, { request: two })).body.error.code).toBe("INVALID_TIDE_REQUEST");

    const other = (await registerOk(owner, { level: 3, name: "Other" })).request.id;
    const otherBase = (await env.as(director).get(`/requests/${other}`)).body.request.tideRequest;
    const wrongBytes = env.realm.approve(otherBase, await env.realm.doken(director));
    expect((await env.as(director).post(`/requests/${request.id}/approve`, { request: wrongBytes })).body.error.code).toBe("INVALID_TIDE_REQUEST");

    const expired = await approve(director, request.id, { doken: await env.realm.doken(director, { exp: Math.floor(Date.now() / 1000) - 5 }) });
    expect(expired.body.error.code).toBe("DOKEN_EXPIRED");
    const noRole = await approve(director, request.id, { doken: await env.realm.doken(director, { roles: ["appUser"] }) });
    expect(noRole.body.error.code).toBe("DOKEN_MISSING_ROLE");

    // A newcomer cannot even read the request; handed the bytes anyway, their approval is refused.
    const outsider = await env.as(newcomer).post(`/requests/${request.id}/approve`, { request: env.realm.approve(base, await env.realm.doken(newcomer)) });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe("NOT_ON_BOARD");

    expect((await approve(director, request.id)).status).toBe(200);
    expect((await approve(director, request.id)).body.error.code).toBe("DUPLICATE_APPROVAL");
  });

  it("a release must decrypt exactly this key's ciphertext, tagged for the vault", async () => {
    const { owner, director, accountant } = env.users;
    const keyA = await sealedKey(owner, [director], { name: "A", level: 2, secret: "aaa" });
    const keyB = await sealedKey(owner, [director], { name: "B", level: 2, secret: "bbb" });
    const ciphertextB = (await env.as(accountant).get(`/keys/${keyB}`)).body.key.ciphertext;

    const swapped = await env.as(accountant).post(`/keys/${keyA}/release`, { reason: "need it", request: env.realm.vault.draftRelease(ciphertextB) });
    expect(swapped.status).toBe(422);
    expect(swapped.body.error.message).toMatch(/different key/);

    const ciphertextA = (await env.as(accountant).get(`/keys/${keyA}`)).body.key.ciphertext;
    const wrongTag = await env.as(accountant).post(`/keys/${keyA}/release`, { reason: "need it", request: env.realm.vault.draftRelease(ciphertextA, { tag: "dob" }) });
    expect(wrongTag.body.error.message).toMatch(/tag/);
    const sealDraft = await env.as(accountant).post(`/keys/${keyA}/release`, { reason: "need it", request: env.realm.vault.draftSeal("x") });
    expect(sealDraft.body.error.message).toMatch(/wrong request model/);
    expect((await env.as(accountant).post(`/keys/${keyA}/release`, { reason: "", request: env.realm.vault.draftRelease(ciphertextA) })).body.error.code).toBe("REASON_REQUIRED");

    expect((await askFor(accountant, keyA)).status).toBe(200);
    expect((await askFor(accountant, keyA)).body.error.code).toBe("OPEN_REQUEST_EXISTS");
  });

  it("sealing stores only the ciphertext the board approved", async () => {
    const { director, accountant } = env.users;
    const first = await registerOk(accountant, { level: 2, name: "First", secret: "one" });
    const second = await registerOk(accountant, { level: 2, name: "Second", secret: "two" });
    await approve(director, first.request.id);
    await approve(director, second.request.id);

    // Produce a valid ciphertext for the SECOND value, then try to file it under the first request.
    const kit2 = (await env.as(accountant).post(`/requests/${second.request.id}/finish-kit`)).body;
    const base2 = (await env.as(accountant).get(`/requests/${second.request.id}`)).body.request.tideRequest;
    const own2 = env.realm.approve(base2, await env.realm.doken(accountant));
    const { ciphertext } = await env.realm.vault.commit(mergeApprovals(own2, kit2.approvals), kit2.policy);

    await env.as(accountant).post(`/requests/${first.request.id}/finish-kit`);
    const base1 = (await env.as(accountant).get(`/requests/${first.request.id}`)).body.request.tideRequest;
    const own1 = env.realm.approve(base1, await env.realm.doken(accountant));
    const res = await env.as(accountant).post(`/requests/${first.request.id}/finish`, { request: own1, ciphertext });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_CIPHERTEXT");

    // Finishing needs the requester's own approval on these exact bytes.
    const notMine = env.realm.approve(base1, await env.realm.doken(director));
    expect((await env.as(accountant).post(`/requests/${first.request.id}/finish`, { request: notMine, ciphertext })).body.error.code).toBe("APPROVER_MISMATCH");
  });

  it("any other board member can reject with a reason; the requester cancels instead", async () => {
    const { owner, director, accountant } = env.users;
    const { key, request } = await registerOk(accountant, { level: 3 });
    expect((await env.as(accountant).post(`/requests/${request.id}/reject`, { reason: "no" })).body.error.code).toBe("USE_CANCEL");
    expect((await env.as(director).post(`/requests/${request.id}/reject`, { reason: " " })).body.error.code).toBe("REASON_REQUIRED");
    const rejected = await env.as(director).post(`/requests/${request.id}/reject`, { reason: "Not our account" });
    expect(rejected.body.status).toBe("rejected");
    expect((await env.as(owner).get(`/keys/${key.id}`)).body.key.status).toBe("rejected");
    expect((await approve(owner, request.id)).body.error.code).toBe("CLOSED");

    const second = await registerOk(accountant, { level: 2, name: "Second" });
    expect((await env.as(director).post(`/requests/${second.request.id}/cancel`)).body.error.code).toBe("NOT_REQUESTER");
    expect((await env.as(accountant).post(`/requests/${second.request.id}/cancel`)).body.status).toBe("cancelled");
  });

  it("open requests expire: a release after 3 days, a seal after 7 (and leaves no key)", async () => {
    const { owner, director, accountant } = env.users;
    const keyId = await sealedKey(owner, [director], { level: 2 });
    const ask = (await askFor(accountant, keyId)).body;
    const seal = (await registerOk(accountant, { level: 2, name: "Late" })).key;
    env.clock.advance(3 * 24 * 3600 * 1000 + 1000);
    expect((await env.as(owner).get(`/requests/${ask.id}`)).body.request.status).toBe("expired");
    expect((await approve(owner, ask.id)).body.error.code).toBe("CLOSED");
    env.clock.advance(4 * 24 * 3600 * 1000);
    expect((await env.as(owner).get(`/keys/${seal.id}`)).body.key.status).toBe("rejected");
  });

  it("someone not on the board sees nothing and can do nothing", async () => {
    const { newcomer } = env.users;
    const me = await env.as(newcomer).get("/me");
    expect(me.status).toBe(200);
    expect(me.body.onBoard).toBe(false);
    for (const path of ["/keys", "/requests", "/board", "/audit", "/tide/setup"]) {
      expect((await env.as(newcomer).get(path)).body.error.code, path).toBe("NOT_ON_BOARD");
    }
    expect((await register(newcomer)).body.error.code).toBe("NOT_ON_BOARD");
  });

  it("the board is read-only: there is no route to change members or roles", async () => {
    const { owner, director } = env.users;
    await env.as(director).get("/me");
    const board = await env.as(owner).get("/board");
    expect(board.status).toBe(200);
    expect(board.body.boardSize).toBe(3);
    for (const path of ["/members/invite", "/members/x/tier", "/join-requests", "/groups"]) {
      expect((await env.as(owner).post(path, {})).status, path).toBe(404);
    }
  });

  it("audit: every step is chained, and an edited entry breaks the chain", async () => {
    const { owner, director } = env.users;
    await sealedKey(owner, [director], { level: 2 });
    const ok = await env.as(owner).get("/audit/verify");
    expect(ok.body.ok).toBe(true);
    const entries = env.deps.audit.all();
    const target = entries[1]!.props;
    env.deps.audit.tamper!(target.seq, { ...target, details: { ...target.details, level: 1 } });
    const broken = await env.as(owner).get("/audit/verify");
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAtSeq).toBe(target.seq);
    // Recomputing that entry's hash does not help: the next entry still points at the old one.
    const forged = { ...target, details: { ...target.details, level: 1 } };
    env.deps.audit.tamper!(target.seq, { ...forged, hash: AuditEntry.hashOf(forged) });
    expect((await env.as(owner).get("/audit/verify")).body.brokenAtSeq).toBe(target.seq + 1);
  });
});

describe("a bigger board", () => {
  it("lifts the cap: with 4 board seats a level-4 key needs 4 approvals", async () => {
    env = await makeEnv({ boardSize: 4 });
    await completeTideSetup(env);
    const { key } = await registerOk(env.users.owner, { level: 4 });
    expect(key.quorum).toBe(4);
  });
});
