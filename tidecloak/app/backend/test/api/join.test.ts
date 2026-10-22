import { beforeEach, describe, expect, it } from "vitest";
import type { Tier } from "../../src/domain/tier.js";
import type { ChangeOutcome, TideDirectory } from "../../src/usecases/ports.js";
import { newUser, type TestUser } from "../helpers/fakeRealm.js";
import { makeEnv, type TestEnv } from "../helpers/testApp.js";

/** Records tier changes; files them one role "change request" at a time like TideCloak does. */
function fakeDirectory() {
  const calls: { userId: string; tiers: Tier[] }[] = [];
  let pendingRounds = 0;
  const dir: TideDirectory = {
    available: true,
    adminPolicy: async () => "",
    listUsers: async () => [],
    pendingChanges: async () => [],
    invite: async () => ({ status: "pending", detail: "", userId: null }),
    inviteLink: async () => "",
    setTiers: async (userId, tiers): Promise<ChangeOutcome> => {
      calls.push({ userId, tiers });
      if (pendingRounds > 0) { pendingRounds--; return { status: "pending", detail: "filed", remaining: Array(pendingRounds).fill("+role") }; }
      return { status: "unchanged", detail: "done", remaining: [] };
    },
  };
  return { dir, calls, setRounds: (n: number) => { pendingRounds = n; } };
}

let env: TestEnv;
let fake: ReturnType<typeof fakeDirectory>;
let newcomer: TestUser;

beforeEach(async () => {
  fake = fakeDirectory();
  env = await makeEnv({ directory: fake.dir });
  // Signed up through Tide: a real Tide identity, but no SignGuard tier yet.
  newcomer = await newUser("Đặng Hoa", []);
});

describe("sign-up → join request → owner approval", () => {
  it("a newcomer with no tier can file a join request, and only one at a time", async () => {
    const first = await env.as(newcomer).post("/join-requests", { requestedTier: "approver", note: "Kế toán trưởng chi nhánh", email: "hoa@example.vn" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: "pending", requestedTier: "approver", name: "Đặng Hoa", memberId: newcomer.sub });
    const again = await env.as(newcomer).post("/join-requests", { requestedTier: "director" });
    expect(again.body.id).toBe(first.body.id);
    expect((await env.as(newcomer).get("/join-requests/mine")).body.request.id).toBe(first.body.id);
  });

  it("refuses to let anyone ask for the owner tier, or a member re-join", async () => {
    expect((await env.as(newcomer).post("/join-requests", { requestedTier: "owner" })).body.error.code).toBe("INVALID_TIER");
    expect((await env.as(env.users.accountant).post("/join-requests", { requestedTier: "viewer" })).body.error.code).toBe("ALREADY_MEMBER");
  });

  it("a newcomer still cannot see documents until approved", async () => {
    expect((await env.as(newcomer).get("/documents")).body.error.code).toBe("NOT_A_MEMBER");
  });

  it("only the owner decides; approving files the role changes towards the requested tier + viewer", async () => {
    const jr = (await env.as(newcomer).post("/join-requests", { requestedTier: "drafter" })).body;
    expect((await env.as(env.users.director).post(`/join-requests/${jr.id}/decision`, { decision: "approve" })).status).toBe(403);
    fake.setRounds(3);
    const decided = await env.as(env.users.owner).post(`/join-requests/${jr.id}/decision`, { decision: "approve" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.request.status).toBe("approved");
    expect(decided.body.outcome.status).toBe("pending");
    expect(fake.calls[0]).toEqual({ userId: newcomer.sub, tiers: ["drafter", "viewer"] });

    // After each approval in Tide, "continue" files the next change from the remembered target.
    await env.as(env.users.owner).post(`/members/${newcomer.sub}/tier/continue`);
    await env.as(env.users.owner).post(`/members/${newcomer.sub}/tier/continue`);
    const done = await env.as(env.users.owner).post(`/members/${newcomer.sub}/tier/continue`);
    expect(done.body.status).toBe("unchanged");
    expect(fake.calls.every((c) => c.tiers.join() === "drafter,viewer")).toBe(true);
    // Target cleared once nothing is left to file.
    const after = await env.as(env.users.owner).post(`/members/${newcomer.sub}/tier/continue`);
    expect(after.body.detail).toMatch(/No tier change in progress/);
  });

  it("a decision is final and audited", async () => {
    const jr = (await env.as(newcomer).post("/join-requests", { requestedTier: "viewer" })).body;
    await env.as(env.users.owner).post(`/join-requests/${jr.id}/decision`, { decision: "reject", note: "Not our staff" });
    expect((await env.as(env.users.owner).post(`/join-requests/${jr.id}/decision`, { decision: "approve" })).body.error.code).toBe("ALREADY_DECIDED");
    const events = (await env.as(env.users.owner).get("/audit")).body.map((e: { event: string }) => e.event);
    expect(events).toEqual(expect.arrayContaining(["member.join_requested", "member.join_decided"]));
  });
});
