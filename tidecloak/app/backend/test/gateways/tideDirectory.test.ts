import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rolesForTiers, TideCloakDirectory } from "../../src/gateways/tideDirectory.js";

/**
 * A small TideCloak admin API simulator with the IGA rule we measured on the live realm:
 * a governed write returns 202 and files a change request, and a SECOND change for the same user
 * while one is pending returns 409 PENDING_CHANGE_REQUEST_CONFLICT. A multi-role grant files only
 * the first role and conflicts on the rest.
 */
function fakeTideCloak() {
  const roles = ["sg_viewer", "sg_drafter", "sg_approver", "sg_director", "sg_owner", "_tide_encryptor", "_tide_decryptor", "appUser"]
    .map((name, i) => ({ id: `r${i}`, name }));
  const userRoles = new Map<string, Set<string>>([["u1", new Set(["appUser"])]]);
  const pending: { id: string; entityId: string; actionType: string; role: string; op: "add" | "remove" }[] = [];
  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/admin/realms/signguard", "");
    if (url.pathname.endsWith("/protocol/openid-connect/token")) return json(200, { access_token: "t" });
    if (path === "/iga/change-requests") return json(200, pending.map((p) => ({ id: p.id, entityId: p.entityId, entityType: "USER", actionType: p.actionType })));
    const role = /^\/roles\/(.+)$/.exec(path);
    if (role) return json(200, roles.find((r) => r.name === decodeURIComponent(role[1]!)));
    const mapping = /^\/users\/(\w+)\/role-mappings\/realm$/.exec(path);
    if (mapping) {
      const uid = mapping[1]!;
      const have = userRoles.get(uid)!;
      if (method === "GET") return json(200, roles.filter((r) => have.has(r.name)));
      const body = JSON.parse(String(init?.body)) as { name: string }[];
      for (const [i, r] of body.entries()) {
        if (pending.some((p) => p.entityId === uid)) {
          return i === 0 ? json(409, { error: "PENDING_CHANGE_REQUEST_CONFLICT" }) : json(409, { error: "PENDING_CHANGE_REQUEST_CONFLICT" });
        }
        pending.push({ id: `cr${pending.length + 1}`, entityId: uid, actionType: method === "POST" ? "GRANT_ROLES" : "REVOKE_ROLES", role: r.name, op: method === "POST" ? "add" : "remove" });
      }
      return new Response(null, { status: 202 });
    }
    return json(404, { error: "not simulated" });
  };

  /** A realm admin approves the oldest pending change in the Tide console. */
  const approveNext = () => {
    const cr = pending.shift();
    if (!cr) return;
    const set = userRoles.get(cr.entityId)!;
    if (cr.op === "add") set.add(cr.role); else set.delete(cr.role);
  };
  return { handler, approveNext, userRoles, pending };
}

describe("TideCloakDirectory.setTiers against IGA's one-pending-change rule", () => {
  let tc: ReturnType<typeof fakeTideCloak>;
  beforeEach(() => {
    tc = fakeTideCloak();
    vi.stubGlobal("fetch", vi.fn(tc.handler));
  });
  afterEach(() => vi.unstubAllGlobals());

  const dir = () => new TideCloakDirectory("http://localhost:8081/", "signguard", { username: "admin", password: "x" });

  it("files one role at a time, most important first, and reports what remains", async () => {
    const out = await dir().setTiers("u1", ["owner", "director", "viewer"]);
    expect(out.status).toBe("pending");
    expect(tc.pending.map((p) => p.role)).toEqual(["sg_owner"]);
    expect(out.remaining).toEqual(["+sg_director", "+sg_viewer", "+_tide_decryptor"]);
  });

  it("does not try to file while a change for that person is pending", async () => {
    await dir().setTiers("u1", ["owner"]);
    const again = await dir().setTiers("u1", ["owner"]);
    expect(again.status).toBe("pending");
    expect(again.detail).toMatch(/already waiting/);
    expect(tc.pending).toHaveLength(1);
  });

  it("converges after one approval per role, then reports unchanged", async () => {
    const wanted = ["owner", "director", "drafter", "viewer"] as const;
    let rounds = 0;
    for (;;) {
      const out = await dir().setTiers("u1", [...wanted]);
      if (out.status !== "pending") { expect(out.status).toBe("unchanged"); break; }
      tc.approveNext();
      if (++rounds > 10) throw new Error("did not converge");
    }
    expect(rounds).toBe(rolesForTiers([...wanted]).length);
    expect([...tc.userRoles.get("u1")!].sort()).toEqual(["appUser", ...rolesForTiers([...wanted])].sort());
  });

  it("removes roles a lower tier no longer needs, and never touches roles it does not manage", async () => {
    tc.userRoles.set("u1", new Set(["appUser", "sg_owner", "sg_viewer", "_tide_decryptor"]));
    const out = await dir().setTiers("u1", ["viewer"]);
    expect(tc.pending[0]).toMatchObject({ op: "remove", role: "sg_owner" });
    expect(out.remaining).toEqual([]);
    tc.approveNext();
    expect((await dir().setTiers("u1", ["viewer"])).status).toBe("unchanged");
    expect(tc.userRoles.get("u1")!.has("appUser")).toBe(true);
  });

  it("maps tiers to roles: every member can read sealed fields, only drafters can write them", () => {
    expect(rolesForTiers(["viewer"])).toEqual(["_tide_decryptor", "sg_viewer"]);
    expect(rolesForTiers(["drafter"])).toEqual(["_tide_decryptor", "_tide_encryptor", "sg_drafter"]);
    expect(rolesForTiers([])).toEqual([]);
  });
});
