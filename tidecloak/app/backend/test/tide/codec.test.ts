import { describe, expect, it } from "vitest";
import { Models, Tools } from "@tideorg/js";
import { container, entries, equalBytes, getValue, utf8 } from "../../src/lib/tideMemory.js";
import { fromBase64, toBase64 } from "../../src/lib/encoding.js";
import { buildDataToVerify, parsePolicy, POLICY_VERSION, wrapSigned, wrapUnsigned, type PolicyFields } from "../../src/tide/policyBytes.js";
import { sealedFieldsPolicyFields, signingRuleFields, statementFields, unsignedPolicy } from "../../src/tide/signguardPolicies.js";
import { checkRequestShape, inspectRequest } from "../../src/tide/requestInspector.js";
import { newRealm, newUser } from "../helpers/fakeRealm.js";

// The real SDK, as the browser uses it. Our server-side codec must produce identical bytes.
const { Policy, ApprovalType, ExecutionType, BaseTideRequest } = Models as any;
const TideMemory = (Tools as any).TideMemory;

function libPolicy(f: PolicyFields) {
  const params = new Map<string, string | number>(Object.keys(f.params).sort().map((k) => [k, f.params[k]!]));
  return new Policy({
    version: Policy.latestVersion, contractId: f.contractId, modelId: f.modelIds, keyId: f.keyId,
    approvalType: ApprovalType[f.approvalType], executionType: ExecutionType[f.executionType], params,
  });
}

const statement = statementFields({
  vendorId: "vendor-1", clientId: "signguard-client", org: "0311111111", requestId: "req_1", docId: "doc_1",
  docNumber: "PC-0001", docType: "payment_voucher", amountDong: "450000000", contentHash: "a".repeat(64),
  band: "mid", policyVersion: 1, initiatorVuid: "b".repeat(64), auditSeq: 7, auditHead: "c".repeat(64),
});

describe("TideMemory container", () => {
  it("matches TideMemory.CreateFromArray byte for byte", () => {
    const values = [utf8("Policy"), new Uint8Array(0), utf8("1"), new Uint8Array([1, 2, 3, 255])];
    expect(equalBytes(container(values), new Uint8Array(TideMemory.CreateFromArray(values)))).toBe(true);
  });

  it("encodes an empty list as zero bytes, like the SDK", () => {
    expect(container([]).length).toBe(0);
    expect(TideMemory.CreateFromArray([]).length).toBe(0);
  });

  it("reads back what the SDK wrote, including nested values", () => {
    const nested = TideMemory.CreateFromArray([utf8("a"), TideMemory.CreateFromArray([utf8("b"), utf8("cd")])]);
    expect(entries(getValue(nested, 1)).map((b) => Buffer.from(b).toString())).toEqual(["b", "cd"]);
  });

  it("throws rather than reading past the end of a truncated buffer", () => {
    const good = container([utf8("hello")]);
    expect(() => getValue(good.subarray(0, good.length - 2), 0)).toThrow();
  });
});

describe("policy bytes", () => {
  it("writes the SDK's current policy version", () => {
    expect(POLICY_VERSION).toBe(Policy.latestVersion);
  });

  for (const [name, fields] of [
    ["approval statement", statement],
    ["signing rule", signingRuleFields("vendor-1", "signguard-client", "sg_director", 2)],
    ["sealed-fields policy", sealedFieldsPolicyFields("vendor-1")],
  ] as const) {
    it(`builds the same dataToVerify as Models.Policy for the ${name}`, () => {
      const ours = buildDataToVerify(fields);
      const theirs = new Uint8Array(libPolicy(fields).dataToVerify);
      expect(toBase64(ours)).toBe(toBase64(theirs));
      expect(toBase64(wrapUnsigned(ours))).toBe(toBase64(new Uint8Array(libPolicy(fields).toBytes())));
    });
  }

  it("round-trips through the SDK's Policy.from, numbers included", () => {
    const rule = signingRuleFields("vendor-1", "signguard-client", "sg_director", 2);
    const parsed = Policy.from(unsignedPolicy(rule));
    expect(parsed.contractId).toBe("GenericRealmAccessThresholdRole:1");
    expect(parsed.modelIds).toEqual(["Policy:1"]);
    expect(parsed.params.getParameter("threshold")).toBe(2);
    expect(parsed.params.getParameter("role")).toBe("sg_director");
  });

  it("parses a signed policy the SDK serialised, signature included", () => {
    const p = libPolicy(statement);
    p.signature = new Uint8Array(64).fill(7);
    const parsed = parsePolicy(new Uint8Array(p.toBytes()));
    expect(parsed.signature?.length).toBe(64);
    expect(parsed.params.contenthash).toBe("a".repeat(64));
    expect(parsed.params.threshold).toBe(99);
    expect(toBase64(wrapSigned(parsed.dataToVerify, parsed.signature!))).toBe(toBase64(new Uint8Array(p.toBytes())));
  });

  it("uses only lowercase-letter parameter names in the statement, so any sort order agrees", () => {
    for (const k of Object.keys(statement.params)) expect(k).toMatch(/^[a-z]+$/);
  });
});

describe("request inspection", () => {
  it("reads a request encoded by the SDK's BaseTideRequest, with approvals added by addApproval", async () => {
    const realm = await newRealm();
    const unsigned = unsignedPolicy(statement);
    const req = new BaseTideRequest("Policy", "1", "Policy:1", TideMemory.CreateFromArray([unsigned]));
    req.setCustomExpiry(3600);
    req.addCreationSignature(BaseTideRequest.uint32ToUint8ArrayLE(Math.floor(Date.now() / 1000)), new Uint8Array(64).fill(1));
    const director = await newUser("Lê Cường", ["sg_director"]);
    const doken = await realm.doken(director);
    req.addApproval({ serialize: () => doken }, new Uint8Array(64).fill(2));

    const inspected = inspectRequest(new Uint8Array(req.encode()));
    expect(inspected.name).toBe("Policy");
    expect(inspected.initialized).toBe(true);
    expect(inspected.approvals.map((a) => a.vuid)).toEqual([director.vuid]);
    expect(inspected.approvalSignatureCount).toBe(1);
    expect(checkRequestShape(inspected, { unsignedPolicy: unsigned, nowSeconds: Math.floor(Date.now() / 1000) })).toBeNull();
  });

  it("the test network simulator writes the same layout the SDK reads", async () => {
    const realm = await newRealm();
    const unsigned = unsignedPolicy(statement);
    const director = await newUser("Lê Cường", ["sg_director"]);
    const approved = realm.approve(realm.initRequest(toBase64(unsigned)), await realm.doken(director));
    const lib = BaseTideRequest.decode(fromBase64(approved));
    expect(lib.isInitialized()).toBe(true);
    expect(lib.getCurrentApprovalCount()).toBe(1);
    expect(equalBytes(new Uint8Array(lib.draft.GetValue(0)), unsigned)).toBe(true);
  });

  it("refuses a request that carries a different statement", async () => {
    const realm = await newRealm();
    const other = unsignedPolicy({ ...statement, params: { ...statement.params, amount: "1" } });
    const inspected = inspectRequest(fromBase64(realm.initRequest(toBase64(other))));
    expect(checkRequestShape(inspected, { unsignedPolicy: unsignedPolicy(statement), nowSeconds: Math.floor(Date.now() / 1000) }))
      .toMatch(/approval statement/);
  });

  it("refuses garbage instead of crashing", () => {
    expect(() => inspectRequest(new Uint8Array([1, 2, 3]))).toThrow(/not a Tide request/);
  });
});
