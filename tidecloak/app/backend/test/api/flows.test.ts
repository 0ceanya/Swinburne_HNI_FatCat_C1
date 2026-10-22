import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditEntry } from "../../src/domain/auditEntry.js";
import { toBase64 } from "../../src/lib/encoding.js";
import { newUser, type TestUser } from "../helpers/fakeRealm.js";
import { completeTideSetup, makeEnv, sealedValues, type TestEnv } from "../helpers/testApp.js";

let env: TestEnv;

async function createDoc(user: TestUser, amountDong: string, type = "payment_voucher", title = "Thanh toán nhà cung cấp") {
  const res = await env.as(user).post("/documents", { type, title, amountDong, resourceGroupId: "general", sealing: "tide-relationship-v1", sealed: sealedValues() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function submit(user: TestUser, docId: string) {
  const res = await env.as(user).post(`/documents/${docId}/submit`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.request;
}

/** What the drafter's browser does right after submitting: open the request on the Tide network. */
async function openOnTide(user: TestUser, req: { id: string; statement: string }) {
  const res = await env.as(user).post(`/signing-requests/${req.id}/tide-request`, { request: env.realm.initRequest(req.statement) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** What an approver's browser does: approve in Tide's enclave, then hand back the updated request. */
async function approveWithTide(user: TestUser, reqId: string, opts: { doken?: string; hash?: string } = {}) {
  const current = (await env.as(user).get(`/signing-requests/${reqId}`)).body.request;
  const doken = opts.doken ?? (await env.realm.doken(user));
  const approved = env.realm.approve(current.tideRequest, doken);
  return env.as(user).post(`/signing-requests/${reqId}/approve/${opts.hash ?? current.contentHash}`, { request: approved, baseVersion: current.tideRequestVersion });
}

/** The network signs the statement once the contract agrees; the executing browser posts it back. */
async function recordNetworkSignature(user: TestUser, reqId: string) {
  const current = (await env.as(user).get(`/signing-requests/${reqId}`)).body.request;
  return env.as(user).post(`/signing-requests/${reqId}/signature`, { signature: await env.realm.signPolicy(current.statement) });
}

const auditEvents = async () => ((await env.as(env.users.owner).get("/audit")).body as { event: string; actor: { name: string } }[]);

describe("with Tide setup complete", () => {
  beforeEach(async () => {
    env = await makeEnv();
    await completeTideSetup(env);
  });

  it("Đồng Tháp replay: the accountant cannot push a 450M voucher through alone", async () => {
    const { accountant, accountant2, director } = env.users;
    const doc = await createDoc(accountant, "450000000", "payment_voucher", "Phiếu chi khống");
    const req = await submit(accountant, doc.id);
    expect(req.requirement.ruleId).toBe("mid");
    expect(req.mode).toBe("tide");
    await openOnTide(accountant, req);

    // The accountant tries to approve their own voucher: refused, and the refusal is logged.
    const self = await approveWithTide(accountant, req.id);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("INITIATOR_CANNOT_APPROVE");
    // A colleague with the same tier cannot stand in for a director either.
    const peer = await approveWithTide(accountant2, req.id);
    expect(peer.status).toBe(403);
    expect(peer.body.error.code).toBe("INELIGIBLE_TIER");

    const pending = (await env.as(director).get("/signing-requests")).body;
    expect(pending.waitingForMe.map((r: { id: string }) => r.id)).toContain(req.id);

    // The director spots the unknown payee on their phone and rejects.
    const reject = await env.as(director).post(`/signing-requests/${req.id}/reject`, { reason: "Unknown payee, no contract on file" });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");
    const after = (await env.as(director).get(`/documents/${doc.id}`)).body.document;
    expect(after.status).toBe("draft");

    const events = await auditEvents();
    expect(events.filter((e) => e.event === "signing.denied_attempt")).toHaveLength(2);
    expect(events.map((e) => e.event)).toContain("signing.rejected");
    expect((await env.as(env.users.owner).get("/audit/verify")).body.ok).toBe(true);
  });

  it("mid band: one director approves and the network's signature is verified before anything is signed", async () => {
    const { accountant, director } = env.users;
    const doc = await createDoc(accountant, "85000000");
    const req = await submit(accountant, doc.id);
    await openOnTide(accountant, req);

    const ok = await approveWithTide(director, req.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe("quorum_met");
    expect(ok.body.approvals[0]).toMatchObject({ name: "Lê Cường", countedAs: "director", proof: { kind: "tide-enclave", dokenVerified: true } });

    // A random 64-byte value, and a real network signature over a DIFFERENT statement, are both refused.
    const fake = await env.as(director).post(`/signing-requests/${req.id}/signature`, { signature: toBase64(randomBytes(64)) });
    expect(fake.status).toBe(422);
    const other = await env.as(director).post(`/signing-requests/${req.id}/signature`, { signature: await env.realm.signBytes(new Uint8Array([1, 2, 3])) });
    expect(other.body.error.code).toBe("SIGNATURE_INVALID");

    const signed = await recordNetworkSignature(director, req.id);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.document.status).toBe("signed");
    expect(signed.body.document.receipts.map((r: { provider: string }) => r.provider)).toEqual(["tide"]);

    const verify = (await env.as(env.users.owner).get("/audit/verify")).body;
    expect(verify).toMatchObject({ ok: true, brokenAtSeq: null });
    expect(verify.anchors).toEqual([expect.objectContaining({ requestId: req.id, signatureValid: true, matchesLog: true })]);
  });

  it("high band: needs the director AND the owner; an e-invoice also gets the (mock) CA signature", async () => {
    const { accountant, director, owner } = env.users;
    const doc = await createDoc(accountant, "640000000", "e_invoice", "Hóa đơn thiết bị");
    const req = await submit(accountant, doc.id);
    expect(req.requirement.ruleId).toBe("high");
    await openOnTide(accountant, req);

    const first = await approveWithTide(director, req.id);
    expect(first.body.status).toBe("collecting");
    expect(first.body.outstanding).toEqual(["owner"]);
    const early = await recordNetworkSignature(director, req.id);
    expect(early.body.error.code).toBe("QUORUM_NOT_MET");

    const second = await approveWithTide(owner, req.id);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe("quorum_met");

    const signed = await recordNetworkSignature(owner, req.id);
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.document.receipts.map((r: { provider: string }) => r.provider)).toEqual(["tide", "mock-ca"]);
  });

  it("an owner who does not also hold sg_director is refused, because the network would not count them", async () => {
    const { accountant, director } = env.users;
    const ownerOnly = await newUser("Hồ Hạnh", ["sg_owner", "sg_viewer"]);
    const doc = await createDoc(accountant, "900000000");
    const req = await submit(accountant, doc.id);
    await openOnTide(accountant, req);
    await approveWithTide(director, req.id);
    const res = await approveWithTide(ownerOnly, req.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MISSING_NETWORK_ROLE");
  });

  it("low band: the drafter signs alone (logged), with the network signature", async () => {
    const { accountant } = env.users;
    const doc = await createDoc(accountant, "5000000");
    const req = await submit(accountant, doc.id);
    expect(req.requirement.ruleId).toBe("low");
    await openOnTide(accountant, req);
    expect((await approveWithTide(accountant, req.id)).body.status).toBe("quorum_met");
    expect((await recordNetworkSignature(accountant, req.id)).body.document.status).toBe("signed");
  });

  it("an approval must be the caller's own, exactly one, on the current bytes, for the hash they saw", async () => {
    const { accountant, director, owner } = env.users;
    const doc = await createDoc(accountant, "640000000");
    const req = await submit(accountant, doc.id);
    await openOnTide(accountant, req);

    // The director submits bytes carrying the owner's approval.
    const mismatch = await approveWithTide(director, req.id, { doken: await env.realm.doken(owner) });
    expect(mismatch.body.error.code).toBe("APPROVER_MISMATCH");

    // Two approvals smuggled in at once.
    const current = (await env.as(director).get(`/signing-requests/${req.id}`)).body.request;
    const double = env.realm.approve(env.realm.approve(current.tideRequest, await env.realm.doken(owner)), await env.realm.doken(director));
    const twice = await env.as(director).post(`/signing-requests/${req.id}/approve/${current.contentHash}`, { request: double, baseVersion: current.tideRequestVersion });
    expect(twice.status).toBe(422);

    // The hash in the URL (covered by the device's DPoP proof) must be the frozen one.
    const wrongHash = await approveWithTide(director, req.id, { hash: "f".repeat(64) });
    expect(wrongHash.body.error.code).toBe("HASH_MISMATCH");

    // A Tide session whose doken lacks the network role is caught early, before the network refuses it.
    const noRole = await approveWithTide(director, req.id, { doken: await env.realm.doken(director, { roles: ["sg_viewer"] }) });
    expect(noRole.body.error.code).toBe("DOKEN_MISSING_ROLE");

    // A doken that has expired.
    const expired = await approveWithTide(director, req.id, { doken: await env.realm.doken(director, { exp: Math.floor(Date.now() / 1000) - 5 }) });
    expect(expired.body.error.code).toBe("DOKEN_EXPIRED");

    // Two approvers working from the same bytes: the second must reload.
    const base = (await env.as(director).get(`/signing-requests/${req.id}`)).body.request;
    const a = await env.as(director).post(`/signing-requests/${req.id}/approve/${base.contentHash}`, { request: env.realm.approve(base.tideRequest, await env.realm.doken(director)), baseVersion: base.tideRequestVersion });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await env.as(owner).post(`/signing-requests/${req.id}/approve/${base.contentHash}`, { request: env.realm.approve(base.tideRequest, await env.realm.doken(owner)), baseVersion: base.tideRequestVersion });
    expect(b.body.error.code).toBe("STALE_REQUEST");
    expect((await approveWithTide(owner, req.id)).body.status).toBe("quorum_met");
  });

  it("the request opened on Tide must carry this document's statement", async () => {
    const { accountant } = env.users;
    const a = await submit(accountant, (await createDoc(accountant, "85000000")).id);
    const b = await submit(accountant, (await createDoc(accountant, "86000000")).id);
    const res = await env.as(accountant).post(`/signing-requests/${a.id}/tide-request`, { request: env.realm.initRequest(b.statement) });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/approval statement/);
  });

  it("editing a pending document cancels its request; resubmitting freezes a new hash", async () => {
    const { accountant } = env.users;
    const doc = await createDoc(accountant, "85000000");
    const req = await submit(accountant, doc.id);
    const edited = await env.as(accountant).patch(`/documents/${doc.id}`, { amountDong: "95000000" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.status).toBe("draft");
    const view = (await env.as(accountant).get(`/documents/${doc.id}`)).body;
    expect(view.requests.find((r: { id: string }) => r.id === req.id).status).toBe("cancelled");
    const again = await submit(accountant, doc.id);
    expect(again.contentHash).not.toBe(req.contentHash);
  });

  it("an open request expires after 7 days and the document returns to Draft", async () => {
    const { accountant, director } = env.users;
    const doc = await createDoc(accountant, "85000000");
    const req = await submit(accountant, doc.id);
    env.clock.advance(8 * 24 * 3600 * 1000);
    const view = (await env.as(director).get(`/documents/${doc.id}`)).body;
    expect(view.document.status).toBe("draft");
    expect(view.requests.find((r: { id: string }) => r.id === req.id).status).toBe("expired");
  });

  it("audit: an edited entry breaks the chain; a full rewrite still fails the Tide-signed anchor", async () => {
    const { accountant, director, owner } = env.users;
    const doc = await createDoc(accountant, "85000000");
    const req = await submit(accountant, doc.id);
    await openOnTide(accountant, req);
    await approveWithTide(director, req.id);
    await recordNetworkSignature(director, req.id);
    expect((await env.as(owner).get("/audit/verify")).body.ok).toBe(true);

    const entries = env.store.audit.all();
    const victim = entries.find((e) => e.props.event === "document.created")!;
    // 1. Someone with database access changes the recorded amount.
    env.store.audit.tamper!(victim.props.seq, { ...victim.props, details: { ...victim.props.details, amountDong: "1000" } });
    const broken = (await env.as(owner).get("/audit/verify")).body;
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtSeq).toBe(victim.props.seq);

    // 2. They also recompute every hash after it, so the chain itself checks out again.
    let prev: AuditEntry | null = null;
    for (const e of env.store.audit.all()) {
      const { seq: _s, prevHash: _p, hash: _h, ...rest } = e.props;
      const rewritten = AuditEntry.next(prev, rest);
      env.store.audit.tamper!(e.props.seq, rewritten.props);
      prev = rewritten;
    }
    const rewritten = (await env.as(owner).get("/audit/verify")).body;
    expect(rewritten.brokenAtSeq).toBeNull();
    expect(rewritten.ok).toBe(false);
    expect(rewritten.anchors[0]).toMatchObject({ signatureValid: true, matchesLog: false });
  });

  it("policy change: needs network rules signed for the new version, then a second person's endorsement", async () => {
    const { owner, director, accountant } = env.users;
    const current = (await env.as(owner).get("/policy")).body[0];
    const rules = current.rules.map((r: Record<string, unknown>) => (r.id === "mid" ? { ...r, label: "20M–300M ₫: + director", maxDong: "300000000" } : r.id === "high" ? { ...r, minDong: "300000001" } : r));
    const proposed = await env.as(owner).post("/policy/drafts", { rules, reason: "Lower the owner threshold to 300M" });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body.version).toBe(2);

    // Opened under v1, keeps v1 even after v2 goes live.
    const oldReq = await submit(accountant, (await createDoc(accountant, "400000000")).id);

    expect((await env.as(owner).post("/policy/2/activate")).body.error.code).toBe("RULES_NOT_SIGNED");
    const setup = (await env.as(owner).get("/tide/setup")).body;
    for (const rule of setup.rules.filter((r: { policyVersion: number }) => r.policyVersion === 2)) {
      await env.as(owner).post(`/tide/rules/2/${rule.ruleId}`, { signature: await env.realm.signPolicy(rule.unsigned) });
    }
    expect((await env.as(owner).post("/policy/2/activate")).body.error.code).toBe("NEEDS_ENDORSEMENT");
    expect((await env.as(owner).post("/policy/2/endorse")).body.error.code).toBe("SELF_ENDORSE");
    expect((await env.as(director).post("/policy/2/endorse")).status).toBe(200);
    const activated = await env.as(owner).post("/policy/2/activate");
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    const newReq = await submit(accountant, (await createDoc(accountant, "400000000")).id);
    expect(newReq.requirement).toMatchObject({ policyVersion: 2, ruleId: "high" });
    const old = (await env.as(director).get(`/signing-requests/${oldReq.id}`)).body.request;
    expect(old.requirement).toMatchObject({ policyVersion: 1, ruleId: "mid" });
  });

  it("enforces tiers on the server for every route", async () => {
    const { viewer, outsider, director, accountant } = env.users;
    const asViewer = await env.as(viewer).post("/documents", { type: "payment_voucher", title: "x", amountDong: "1", resourceGroupId: "general", sealing: "tide-relationship-v1", sealed: sealedValues() });
    expect(asViewer.status).toBe(403);
    expect((await env.as(outsider).get("/documents")).body.error.code).toBe("NOT_A_MEMBER");
    expect((await env.as(director).get("/tide/admin-policy")).body.error.code).toBe("NOT_REALM_ADMIN");
    expect((await env.as(accountant).get("/audit")).status).toBe(403);
    expect((await env.as(accountant).post("/policy/drafts", { rules: [], reason: "x" })).status).toBe(403);
  });
});

describe("before Tide setup", () => {
  beforeEach(async () => { env = await makeEnv(); });

  it("refuses to submit until the network rule is signed, and to seal until the policy exists", async () => {
    const { accountant } = env.users;
    const sealedRes = await env.as(accountant).post("/documents", { type: "payment_voucher", title: "x", amountDong: "85000000", resourceGroupId: "general", sealing: "tide-relationship-v1", sealed: sealedValues() });
    expect(sealedRes.body.error.code).toBe("SEALING_NOT_SET_UP");
    const plain = await env.as(accountant).post("/documents", { type: "payment_voucher", title: "x", amountDong: "85000000", resourceGroupId: "general", sealing: "plaintext-dev", sealed: sealedValues() });
    expect(plain.status).toBe(200);
    const res = await env.as(accountant).post(`/documents/${plain.body.id}/submit`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TIDE_SIGNING_NOT_SET_UP");
  });

  it("rejects unauthenticated calls", async () => {
    const { default: request } = await import("supertest");
    expect((await request(env.app).get("/api/documents")).status).toBe(401);
    expect((await request(env.app).get("/api/health")).status).toBe(200);
  });

  it("records a rule signature that does not verify, and says so", async () => {
    const setup = (await env.as(env.users.owner).get("/tide/setup")).body;
    const res = await env.as(env.users.owner).post(`/tide/rules/1/${setup.rules[0].ruleId}`, { signature: toBase64(randomBytes(64)) });
    expect(res.status).toBe(200);
    expect(res.body.signatureVerified).toBe(false);
  });
});

describe("unsigned dev mode (never for a demo)", () => {
  it("completes without the network only when explicitly enabled, and labels the receipt", async () => {
    env = await makeEnv({ allowUnsignedDev: true });
    const { accountant, director } = env.users;
    const doc = await env.as(accountant).post("/documents", { type: "payment_voucher", title: "x", amountDong: "85000000", resourceGroupId: "general", sealing: "plaintext-dev", sealed: sealedValues() });
    const req = (await env.as(accountant).post(`/documents/${doc.body.id}/submit`)).body.request;
    expect(req.mode).toBe("unsigned-dev");
    const res = await env.as(director).post(`/signing-requests/${req.id}/approve/${req.contentHash}`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = (await env.as(director).get(`/documents/${doc.body.id}`)).body.document;
    expect(view.status).toBe("signed");
    expect(view.receipts[0].provider).toBe("dev-unsigned");
  });
});
