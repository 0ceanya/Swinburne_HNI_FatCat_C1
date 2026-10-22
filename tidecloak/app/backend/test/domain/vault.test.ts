import { describe, expect, it } from "vitest";
import { AuditEntry, checkChain, type AuditEntryProps } from "../../src/domain/auditEntry.js";
import { KeyRequest, type MemberIdentity } from "../../src/domain/keyRequest.js";
import { KEY_KINDS, quorumFor, VaultKey } from "../../src/domain/vaultKey.js";

const T0 = "2026-10-22T10:00:00.000Z";
const member = (id: string, onBoard = true): MemberIdentity => ({ memberId: id, vuid: `vuid-${id}`, name: id, onBoard });
const approval = { doken: "d", signature: "s", dokenVerified: true, deviceKey: null };

function request(quorum: number, operation: "seal" | "release" = "release") {
  return KeyRequest.open({
    id: "req_1", keyId: "key_1", keyName: "AWS root", keyLevel: 4, operation, quorum,
    requester: { memberId: "acc", vuid: "vuid-acc", name: "acc" }, reason: "rotate", tideRequest: "AAAA",
    createdAt: T0, expiresAt: "2026-10-25T10:00:00.000Z",
  });
}

describe("levels and quorum", () => {
  it("needs as many people as the level, capped at the board size", () => {
    expect([1, 2, 3, 4].map((l) => quorumFor(l as 1, 3))).toEqual([1, 2, 3, 3]);
    expect(quorumFor(4, 5)).toBe(4);
    expect(() => quorumFor(2, 0)).toThrow();
  });

  it("suggests a level per key type: cloud root 4, digital signature 3, API key 2", () => {
    const level = (id: string) => KEY_KINDS.find((k) => k.id === id)!.defaultLevel;
    expect(level("cloud_root")).toBe(4);
    expect(level("digital_signature")).toBe(3);
    expect(level("api_key")).toBe(2);
  });

  it("validates a new key and fixes its quorum when registered", () => {
    const by = { id: "u", name: "U" };
    const key = VaultKey.register("key_1", "req_1", { name: " Viettel MySign ", kind: "digital_signature", provider: "Viettel", description: "", hint: "", level: 4 }, 3, by, T0);
    expect(key.snapshot().name).toBe("Viettel MySign");
    expect(key.quorum).toBe(3);
    expect(key.status).toBe("pending_seal");
    expect(() => VaultKey.register("k", "r", { name: "x", kind: "nope", provider: "", description: "", hint: "", level: 2 }, 3, by, T0)).toThrow(/type/);
    expect(() => VaultKey.register("k", "r", { name: "x", kind: "api_key", provider: "", description: "", hint: "", level: 5 }, 3, by, T0)).toThrow(/Level/);
    expect(() => VaultKey.register("k", "r", { name: "", kind: "api_key", provider: "", description: "", hint: "", level: 2 }, 3, by, T0)).toThrow(/Name/);
  });

  it("a key is usable only once sealed, and can be released only while active", () => {
    const key = VaultKey.register("k", "r", { name: "x", kind: "api_key", provider: "", description: "", hint: "", level: 2 }, 3, { id: "u", name: "U" }, T0);
    expect(() => key.recordRelease({ id: "u", name: "U" }, T0)).toThrow(/not in the vault/);
    key.seal("ciphertext", T0);
    key.recordRelease({ id: "d", name: "D" }, T0);
    expect(key.snapshot().releaseCount).toBe(1);
    expect(() => key.seal("again", T0)).toThrow();
  });
});

describe("KeyRequest", () => {
  it("a quorum of 3 needs the requester plus 2 others, and the requester never approves through the inbox", () => {
    const req = request(3);
    expect(req.status).toBe("collecting");
    expect(req.othersNeeded()).toBe(2);
    expect(() => req.approve(member("acc"), approval, T0)).toThrow(/finish/);
    req.approve(member("dir"), approval, T0);
    expect(req.status).toBe("collecting");
    req.approve(member("own"), approval, T0);
    expect(req.status).toBe("ready");
    expect(() => req.approve(member("x"), approval, T0)).toThrow(/All the approvals/);
  });

  it("recognises the requester by vuid as well as by account id", () => {
    const req = request(2);
    expect(() => req.approve({ memberId: "other-account", vuid: "vuid-acc", name: "acc", onBoard: true }, approval, T0)).toThrow(/finish/);
  });

  it("refuses duplicates and people who are not on the board", () => {
    const req = request(3);
    req.approve(member("dir"), approval, T0);
    expect(() => req.approve(member("dir"), approval, T0)).toThrow(/already approved/);
    expect(() => req.approve({ memberId: "x", vuid: "vuid-dir", name: "x", onBoard: true }, approval, T0)).toThrow(/already approved/);
    expect(() => req.approve(member("new", false), approval, T0)).toThrow(/board/);
  });

  it("a quorum of 1 is ready at once: the requester alone finishes", () => {
    const req = request(1);
    expect(req.status).toBe("ready");
    req.finish({ memberId: "acc", vuid: "vuid-acc" }, true, T0);
    expect(req.status).toBe("completed");
  });

  it("only the requester finishes, and only when ready", () => {
    const req = request(2);
    expect(() => req.checkCanFinish({ memberId: "acc", vuid: "vuid-acc" }, T0)).toThrow(/Waiting for 1/);
    req.approve(member("dir"), approval, T0);
    expect(() => req.checkCanFinish({ memberId: "dir", vuid: "vuid-dir" }, T0)).toThrow(/Only the person/);
    req.finish({ memberId: "acc", vuid: "vuid-acc" }, true, T0);
    expect(req.snapshot().closedReason).toMatch(/Unlocked for acc/);
  });

  it("another board member rejects with a reason; the requester cancels instead", () => {
    const req = request(3);
    expect(() => req.reject(member("acc"), "no", T0)).toThrow(/Cancel/);
    expect(() => req.reject(member("dir"), "  ", T0)).toThrow(/why/);
    expect(() => req.reject(member("new", false), "no", T0)).toThrow(/board/);
    req.reject(member("dir"), "Unknown purpose", T0);
    expect(req.status).toBe("rejected");
    expect(() => req.approve(member("own"), approval, T0)).toThrow(/rejected/);
    const other = request(2);
    expect(() => other.cancel({ memberId: "dir", vuid: "vuid-dir" }, T0)).toThrow(/Only the person/);
    other.cancel({ memberId: "acc", vuid: "vuid-acc" }, T0);
    expect(other.status).toBe("cancelled");
  });

  it("expires, and an expired request accepts nothing", () => {
    const req = request(2);
    expect(req.expireIfDue("2026-10-25T10:00:00.000Z")).toBe(true);
    expect(req.status).toBe("expired");
    expect(() => req.approve(member("dir"), approval, "2026-10-25T10:00:01.000Z")).toThrow(/expired/);
  });
});

describe("Audit chain", () => {
  const entry = (prev: AuditEntry | null, n: number) =>
    AuditEntry.next(prev, { at: T0, event: "request.approved", actor: { id: "a", name: "A" }, keyId: "key_1", requestId: `req_${n}`, details: { n } });
  const chain = () => { const out: AuditEntry[] = []; for (let i = 0; i < 5; i++) out.push(entry(out.at(-1) ?? null, i)); return out; };

  it("verifies an untouched chain", () => {
    expect(checkChain(chain())).toMatchObject({ ok: true, length: 5, brokenAtSeq: null });
  });

  it("finds the first edited entry", () => {
    const entries = chain();
    const p = entries[2]!.props;
    entries[2] = AuditEntry.restore({ ...p, details: { n: 99 } } as AuditEntryProps);
    expect(checkChain(entries).brokenAtSeq).toBe(3);
  });
});
