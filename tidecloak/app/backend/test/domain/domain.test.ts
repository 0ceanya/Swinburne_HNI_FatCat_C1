import { describe, expect, it } from "vitest";
import { ApprovalPolicy, defaultRules, type ApprovalRuleProps } from "../../src/domain/approvalPolicy.js";
import { AuditEntry, checkChain } from "../../src/domain/auditEntry.js";
import { Document } from "../../src/domain/document.js";
import { DomainError } from "../../src/domain/errors.js";
import { Money } from "../../src/domain/money.js";
import { matchApprovers, SigningRequest, type MemberIdentity } from "../../src/domain/signingRequest.js";

const NOW = "2026-10-22T03:00:00.000Z";
const LATER = "2026-10-22T04:00:00.000Z";
const actor = { id: "u-acct", name: "Trần Bình" };
const sealed = { counterparty: "ct:abc", bankAccount: "ct:def", description: "" };

const activePolicy = () => {
  const p = ApprovalPolicy.propose(1, defaultRules(), "initial", { id: "system", name: "SignGuard" }, NOW);
  p.activate(NOW, { bootstrap: true });
  return p;
};

const draft = (amount: string, type: "payment_voucher" | "e_invoice" = "payment_voucher") =>
  Document.createDraft("doc_1", "PC-0001", { type, title: "Thanh toán hợp đồng", amount: Money.ofDong(amount), resourceGroupId: "general", sealing: "tide-relationship-v1", sealed }, actor, NOW);

const member = (id: string, tiers: MemberIdentity["tiers"]): MemberIdentity => ({ memberId: id, vuid: `v-${id}`, name: id, tiers });

function openRequest(amount: string) {
  const doc = draft(amount);
  const requirement = activePolicy().requirementFor(doc.type, doc.amount);
  const hash = doc.submit("req_1", NOW);
  return SigningRequest.open({
    id: "req_1", documentId: doc.id, documentNumber: doc.number, documentType: doc.type, amountDong: amount,
    contentHash: hash.hex, requirement, initiator: { memberId: "u-acct", vuid: "v-u-acct", name: "Trần Bình" },
    mode: "tide", createdAt: NOW, expiresAt: "2026-10-29T03:00:00.000Z", statement: "", auditAnchor: { seq: 1, hash: "0".repeat(64) },
  });
}

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof DomainError ? e.code : String(e); }
  return "no error";
};

describe("Money", () => {
  it("accepts whole đồng as digits and formats with Vietnamese grouping", () => {
    expect(Money.ofDong("640000000").format()).toBe("640.000.000 ₫");
    expect(Money.ofDong(0).format()).toBe("0 ₫");
  });
  it.each(["1.5", "-1", "1e9", " 10", "010", "", "1,000"])("rejects %j", (v) => {
    expect(code(() => Money.ofDong(v))).toBe("INVALID_AMOUNT");
  });
  it("holds amounts above 2^31 exactly (no int32 or float overflow)", () => {
    expect(Money.ofDong("2100000000000").toString()).toBe("2100000000000");
  });
});

describe("Document", () => {
  it("freezes the content hash on submit, and the hash covers the content", () => {
    const doc = draft("450000000");
    const before = doc.computeHash();
    const hash = doc.submit("req_1", NOW);
    expect(hash.hex).toBe(before.hex);
    expect(doc.status).toBe("pending_approval");
    expect(code(() => doc.edit({ title: "changed" }, LATER))).toBe("NOT_DRAFT");
  });

  it("changes the hash when any field changes, including sealed ciphertext", () => {
    const a = draft("450000000");
    const b = draft("450000000");
    b.edit({ sealed: { ...sealed, counterparty: "ct:other" } }, LATER);
    const c = draft("450000001");
    expect(new Set([a.computeHash().hex, b.computeHash().hex, c.computeHash().hex]).size).toBe(3);
  });

  it("returns to Draft on reject/withdraw and clears the frozen hash", () => {
    const doc = draft("450000000");
    doc.submit("req_1", NOW);
    doc.returnToDraft(LATER);
    expect(doc.status).toBe("draft");
    expect(doc.contentHash).toBeNull();
  });

  it("refuses to mark signed if the stored content no longer matches the approved hash", () => {
    const doc = draft("450000000");
    doc.submit("req_1", NOW);
    const snap = doc.snapshot();
    const tampered = Document.restore({ ...snap, title: "Different title" });
    expect(code(() => tampered.markSigned([{ provider: "tide", signature: "x", signedAt: LATER, covers: "x" }], LATER))).toBe("HASH_MISMATCH");
  });
});

describe("ApprovalPolicy", () => {
  it("maps amounts to the pitch's tiers, boundaries included", () => {
    const p = activePolicy();
    const rule = (a: string) => p.requirementFor("payment_voucher", Money.ofDong(a)).ruleId;
    expect(rule("19999999")).toBe("low");
    expect(rule("20000000")).toBe("mid");
    expect(rule("500000000")).toBe("mid");
    expect(rule("500000001")).toBe("high");
    expect(rule("2100000000")).toBe("high");
  });

  it("rejects a policy with a gap or an overlap in the amount ranges", () => {
    const rules = defaultRules();
    const gap = rules.map((r): ApprovalRuleProps => (r.id === "mid" ? { ...r, minDong: r.minDong + 1n } : r));
    const overlap = rules.map((r): ApprovalRuleProps => (r.id === "low" ? { ...r, maxDong: 20_000_000n } : r));
    expect(code(() => ApprovalPolicy.propose(2, gap, "x", actor, NOW))).toBe("INVALID_POLICY");
    expect(code(() => ApprovalPolicy.propose(2, overlap, "x", actor, NOW))).toBe("INVALID_POLICY");
  });

  it("needs a second director/owner to endorse before activation, and the proposer cannot endorse", () => {
    const p = ApprovalPolicy.propose(2, defaultRules(), "raise limits", { id: "owner", name: "Owner" }, NOW);
    expect(code(() => p.activate(LATER))).toBe("NEEDS_ENDORSEMENT");
    expect(code(() => p.endorse({ id: "owner", name: "Owner", tiers: ["owner"] }, LATER))).toBe("SELF_ENDORSE");
    expect(code(() => p.endorse({ id: "acct", name: "Acct", tiers: ["drafter"] }, LATER))).toBe("INELIGIBLE");
    p.endorse({ id: "dir", name: "Director", tiers: ["director"] }, LATER);
    p.activate(LATER);
    expect(p.status).toBe("active");
  });

  it("keeps the network threshold within the number of approvals", () => {
    const bad = defaultRules().map((r) => (r.id === "mid" ? { ...r, network: { role: "sg_director", threshold: 3 } } : r));
    expect(code(() => ApprovalPolicy.propose(2, bad, "x", actor, NOW))).toBe("INVALID_RULE");
  });
});

describe("SigningRequest", () => {
  it("never lets the initiator approve their own mid-band request (the Đồng Tháp fix)", () => {
    const req = openRequest("450000000");
    expect(code(() => req.approve(member("u-acct", ["drafter", "director"]), { kind: "tide-enclave" }, LATER))).toBe("INITIATOR_CANNOT_APPROVE");
    expect(req.approvals).toHaveLength(0);
  });

  it("recognises the initiator by vuid as well as by account id", () => {
    const req = openRequest("450000000");
    const sameVuidOtherAccount = { memberId: "other-account", vuid: "v-u-acct", name: "x", tiers: ["director" as const] };
    expect(code(() => req.approve(sameVuidOtherAccount, { kind: "tide-enclave" }, LATER))).toBe("INITIATOR_CANNOT_APPROVE");
  });

  it("meets a mid-band quorum with one director", () => {
    const req = openRequest("450000000");
    req.approve(member("dir", ["director"]), { kind: "tide-enclave" }, LATER);
    expect(req.status).toBe("quorum_met");
    expect(req.outstanding()).toEqual([]);
  });

  it("rejects duplicates and tiers the rule does not need", () => {
    const req = openRequest("640000000");
    req.approve(member("dir", ["director"]), { kind: "tide-enclave" }, LATER);
    expect(code(() => req.approve(member("dir", ["director"]), { kind: "tide-enclave" }, LATER))).toBe("DUPLICATE_APPROVAL");
    expect(code(() => req.approve(member("viewer", ["viewer"]), { kind: "tide-enclave" }, LATER))).toBe("INELIGIBLE_TIER");
    expect(code(() => req.approve(member("dir2", ["director"]), { kind: "tide-enclave" }, LATER))).toBe("TIER_ALREADY_SATISFIED");
    expect(req.status).toBe("collecting");
    expect(req.outstanding()).toEqual(["owner"]);
  });

  it("assigns slots optimally: an owner approving first does not block the director", () => {
    const req = openRequest("640000000");
    req.approve(member("owner", ["owner", "director"]), { kind: "tide-enclave" }, LATER);
    expect(req.status).toBe("collecting");
    req.approve(member("dir", ["director"]), { kind: "tide-enclave" }, LATER);
    expect(req.status).toBe("quorum_met");
  });

  it("lets the drafter approve alone only in the low band", () => {
    const req = openRequest("5000000");
    req.approve(member("u-acct", ["drafter"]), { kind: "tide-enclave" }, LATER);
    expect(req.status).toBe("quorum_met");
  });

  it("expires, and an expired request accepts nothing", () => {
    const req = openRequest("450000000");
    expect(code(() => req.approve(member("dir", ["director"]), { kind: "tide-enclave" }, "2026-11-01T00:00:00.000Z"))).toBe("EXPIRED");
    expect(req.status).toBe("expired");
  });

  it("only an eligible approver can reject, and a reason is required", () => {
    const req = openRequest("450000000");
    expect(code(() => req.reject(member("viewer", ["viewer"]), "no", LATER))).toBe("INELIGIBLE_TIER");
    expect(code(() => req.reject(member("u-acct", ["drafter"]), "no", LATER))).toBe("USE_WITHDRAW");
    expect(code(() => req.reject(member("dir", ["director"]), "  ", LATER))).toBe("REASON_REQUIRED");
    req.reject(member("dir", ["director"]), "Unknown payee", LATER);
    expect(req.status).toBe("rejected");
  });

  it("guards the stored Tide request against concurrent writers", () => {
    const req = openRequest("640000000");
    req.setTideRequest("AAAA", 0, LATER);
    expect(code(() => req.setTideRequest("BBBB", 0, LATER))).toBe("STALE_REQUEST");
    req.setTideRequest("BBBB", 1, LATER);
    expect(req.tideRequestVersion).toBe(2);
  });

  it("matching is maximal for awkward tier mixes", () => {
    expect(matchApprovers(["director", "owner"], [["owner", "director"], ["director"]])).toEqual([1, 0]);
    expect(matchApprovers(["director", "owner"], [["director"], ["director"]]).filter((x) => x !== null)).toHaveLength(1);
  });
});

describe("Audit chain", () => {
  const append = (entries: AuditEntry[], event: "document.created" | "document.submitted") => {
    entries.push(AuditEntry.next(entries.at(-1) ?? null, { at: NOW, event, actor, documentId: "doc_1", contentHash: null, details: { n: entries.length } }));
  };

  it("verifies an untouched chain", () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 5; i++) append(entries, "document.created");
    expect(checkChain(entries)).toMatchObject({ ok: true, length: 5, brokenAtSeq: null });
  });

  it("finds the first edited entry", () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 5; i++) append(entries, "document.created");
    entries[2] = AuditEntry.restore({ ...entries[2]!.props, details: { n: 99 } });
    expect(checkChain(entries).brokenAtSeq).toBe(3);
  });

  it("a full rewrite passes the chain check but changes the recomputed hashes (anchors catch it)", () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 5; i++) append(entries, "document.created");
    const anchoredHead = entries[3]!.props.hash;
    // The attacker edits entry 2 and recomputes every later hash.
    const forged: AuditEntry[] = [];
    entries.forEach((e, i) => {
      const details = i === 1 ? { n: 99 } : e.props.details;
      forged.push(AuditEntry.next(forged.at(-1) ?? null, { at: e.props.at, event: e.props.event, actor: e.props.actor, documentId: e.props.documentId, contentHash: e.props.contentHash, details }));
    });
    const check = checkChain(forged);
    expect(check.ok).toBe(true);
    expect(check.recomputed.get(4)).not.toBe(anchoredHead);
  });
});
