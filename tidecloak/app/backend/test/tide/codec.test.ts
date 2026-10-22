import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Cryptide, Flow, Models, Tools } from "@tideorg/js";
// Not re-exported from Models; the SDK has no exports map, so the module path is public.
// @ts-expect-error: deep import of the SDK's ESM build, typed below
import PolicyProtectedSerializedFieldModule from "@tideorg/js/dist/Models/PolicyProtectedSerializedField";
import { container, entries, equalBytes, getValue, utf8 } from "../../src/lib/tideMemory.js";
import { fromBase64, toBase64 } from "../../src/lib/encoding.js";
import { buildDataToVerify, parsePolicy, POLICY_VERSION, wrapUnsigned, type PolicyFields } from "../../src/tide/policyBytes.js";
import { checkVaultDraft, inspectRequest, readDraftEntry, singleApprovalOn } from "../../src/tide/requestInspector.js";
import { draftMatchesField, parseSealedField } from "../../src/tide/sealedField.js";
import { unsignedPolicy, VAULT_TAG, vaultPolicyFields } from "../../src/tide/vaultPolicies.js";
import { newRealm, newUser } from "../helpers/fakeRealm.js";

// The real SDK, as the browser and Tide's enclave use it. Our server-side codec must agree with it.
const { Policy, ApprovalType, ExecutionType, BaseTideRequest } = Models as any;
const PolicyProtectedSerializedField = PolicyProtectedSerializedFieldModule as any;
const TideMemory = (Tools as any).TideMemory;
const { PolicyAuthorizedEncryptionFlow } = (Flow as any).EncryptionFlows;
const { Point } = (Cryptide as any).Ed25519;
// The SDK's large-value path uses window.crypto for the data key.
(globalThis as any).window ??= { crypto: webcrypto };

const now = () => Math.floor(Date.now() / 1000);

function libPolicy(f: PolicyFields) {
  const params = new Map<string, string | number>(Object.keys(f.params).sort().map((k) => [k, f.params[k]!]));
  return new Policy({
    version: Policy.latestVersion, contractId: f.contractId, modelId: f.modelIds, keyId: f.keyId,
    approvalType: ApprovalType[f.approvalType], executionType: ExecutionType[f.executionType], params,
  });
}

/** What Tide's enclave hands back from doDraftEncryption: the SDK's own request builder, then initialised. */
async function sdkSealDraft(secret: Uint8Array) {
  const vvkPublic = Point.BASE.multiply(123456789n);
  const { request } = await PolicyAuthorizedEncryptionFlow.prototype.createEncryptionRequest.call(
    { vvkInfo: { UserPublic: vvkPublic } }, [{ data: secret, tags: [VAULT_TAG] }], true);
  request.addCreationSignature(BaseTideRequest.uint32ToUint8ArrayLE(now()), new Uint8Array(64).fill(9));
  return request;
}

/** What commitEncryption returns once the network signed: the stored field plus the signature. */
function sdkCommittedField(sealRequest: any) {
  const stored = PolicyProtectedSerializedField.deserialize(new Uint8Array(sealRequest.authorizerCert.GetValue(0)));
  return new Uint8Array(PolicyProtectedSerializedField.create(stored.encFieldChk, stored.timestamp, stored.encKey, new Uint8Array(64).fill(5)));
}

/** What Tide's enclave hands back from doDraftDecryption for a stored ciphertext. */
function sdkReleaseDraft(field: Uint8Array, tag = VAULT_TAG) {
  const { request } = PolicyAuthorizedEncryptionFlow.prototype.createDecryptionRequest.call({}, [{ encrypted: field, tags: [tag] }], true);
  request.addCreationSignature(BaseTideRequest.uint32ToUint8ArrayLE(now()), new Uint8Array(64).fill(7));
  return request;
}

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

describe("vault policy bytes", () => {
  it("writes the SDK's current policy version", () => {
    expect(POLICY_VERSION).toBe(Policy.latestVersion);
  });

  it.each([1, 2, 3])("builds the same bytes as Models.Policy for the %i-approval policy", (threshold) => {
    const fields = vaultPolicyFields("vendor-1", "signguard-client", threshold);
    expect(toBase64(buildDataToVerify(fields))).toBe(toBase64(new Uint8Array(libPolicy(fields).dataToVerify)));
    expect(toBase64(wrapUnsigned(buildDataToVerify(fields)))).toBe(toBase64(new Uint8Array(libPolicy(fields).toBytes())));
  });

  it("covers sealing and unlocking, needs explicit approvals, and counts board members", () => {
    const parsed = Policy.from(unsignedPolicy(vaultPolicyFields("vendor-1", "signguard-client", 3)));
    expect(parsed.contractId).toBe("GenericRealmAccessThresholdRole:1");
    expect(parsed.modelIds).toEqual(["PolicyEnabledEncryption:1", "PolicyEnabledDecryption:1"]);
    expect(parsed.approvalType).toBe(ApprovalType.EXPLICIT);
    expect(parsed.params.getParameter("threshold")).toBe(3);
    expect(parsed.params.getParameter("role")).toBe("sg_viewer");
    expect(parsePolicy(unsignedPolicy(vaultPolicyFields("v", "c", 2))).params.threshold).toBe(2);
  });

  it("the SDK's own threshold contract accepts our policy for both vault models, and only with enough board approvals", async () => {
    const { GenericRealmAccessThresholdRoleContract } = (await import("@tideorg/js")).Contracts as any;
    const realm = await newRealm();
    const [a, b, outsider] = await Promise.all([newUser("A B", ["sg_viewer"]), newUser("C D", ["sg_viewer"]), newUser("E F", [])]);
    const policy = libPolicy(vaultPolicyFields("vendor-1", "signguard-client", 2));
    const drafts = [await sdkSealDraft(utf8("pin-1234")), sdkReleaseDraft(sdkCommittedField(await sdkSealDraft(utf8("x"))))];
    for (const draft of drafts) {
      const withApprovals = async (people: (typeof a)[]) => {
        const r = BaseTideRequest.decode(new Uint8Array(draft.encode()));
        for (const u of people) { const d = await realm.doken(u); r.addApproval({ serialize: () => d }, new Uint8Array(64)); }
        return new Uint8Array(r.encode());
      };
      const run = async (people: (typeof a)[]) => new GenericRealmAccessThresholdRoleContract(await withApprovals(people)).testPolicy(policy);
      expect((await run([a, b])).success).toBe(true);
      expect((await run([a])).success).toBe(false);
      expect((await run([a, outsider])).success).toBe(false);
    }
  });
});

describe("vault drafts built by the SDK", () => {
  it.each([["a short PIN", "123456"], ["a long credential", "-----BEGIN PRIVATE KEY-----\n" + "M".repeat(200)]])(
    "a seal of %s passes the server's draft check, and the committed ciphertext matches it", async (_label, secret) => {
      const request = await sdkSealDraft(utf8(secret));
      const inspected = inspectRequest(new Uint8Array(request.encode()));
      expect(checkVaultDraft(inspected, { name: "PolicyEnabledEncryption", tag: VAULT_TAG, nowSeconds: now() })).toBeNull();
      const field = sdkCommittedField(request);
      const entry = readDraftEntry("PolicyEnabledEncryption", inspected.draft);
      expect(draftMatchesField(entry, parseSealedField(field), { checkSignature: false })).toBe(true);
      // A different seal's ciphertext does not match.
      const other = sdkCommittedField(await sdkSealDraft(utf8(secret)));
      expect(draftMatchesField(entry, parseSealedField(other), { checkSignature: false })).toBe(false);
    });

  it("the ciphertext never contains the secret in the clear", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE-very-secret-value";
    const request = await sdkSealDraft(utf8(secret));
    const all = Buffer.from(new Uint8Array(request.encode()));
    expect(all.includes(Buffer.from(secret))).toBe(false);
    expect(Buffer.from(sdkCommittedField(request)).includes(Buffer.from(secret))).toBe(false);
  });

  it("a release drafted for a stored ciphertext passes the server's checks and points at exactly that ciphertext", async () => {
    const field = sdkCommittedField(await sdkSealDraft(utf8("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")));
    const inspected = inspectRequest(new Uint8Array(sdkReleaseDraft(field).encode()));
    expect(checkVaultDraft(inspected, { name: "PolicyEnabledDecryption", tag: VAULT_TAG, nowSeconds: now() })).toBeNull();
    const entry = readDraftEntry("PolicyEnabledDecryption", inspected.draft);
    expect(draftMatchesField(entry, parseSealedField(field), { checkSignature: true })).toBe(true);
    const otherField = sdkCommittedField(await sdkSealDraft(utf8("another")));
    expect(draftMatchesField(entry, parseSealedField(otherField), { checkSignature: true })).toBe(false);
  });

  it("refuses a release drafted with another tag, or a seal presented as a release", async () => {
    const seal = await sdkSealDraft(utf8("x"));
    const field = sdkCommittedField(seal);
    const wrongTag = inspectRequest(new Uint8Array(sdkReleaseDraft(field, "dob").encode()));
    expect(checkVaultDraft(wrongTag, { name: "PolicyEnabledDecryption", tag: VAULT_TAG, nowSeconds: now() })).toMatch(/tag/);
    const asRelease = inspectRequest(new Uint8Array(seal.encode()));
    expect(checkVaultDraft(asRelease, { name: "PolicyEnabledDecryption", tag: VAULT_TAG, nowSeconds: now() })).toMatch(/wrong request model/);
  });

  it("parses the SDK's sealed field for both value sizes", async () => {
    for (const secret of ["short", "x".repeat(64)]) {
      const parsed = parseSealedField(sdkCommittedField(await sdkSealDraft(utf8(secret))));
      expect(parsed.c1.length).toBe(32);
      expect(parsed.timestamp.length).toBe(8);
      expect(parsed.signature.length).toBe(64);
    }
    expect(() => parseSealedField(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("approvals collected separately, merged by the requester", () => {
  it("each approval is checked on its own, and the SDK merges them into one request the network can count", async () => {
    const realm = await newRealm();
    const [a, b] = await Promise.all([newUser("Lê Cường", ["sg_viewer"]), newUser("Trần Bình", ["sg_viewer"])]);
    const base = new Uint8Array(sdkReleaseDraft(sdkCommittedField(await sdkSealDraft(utf8("k")))).encode());
    const baseInspected = inspectRequest(base);

    // Two people approve the same stored bytes in their own browsers.
    const approveAs = async (u: typeof a, sig: number) => {
      const r = BaseTideRequest.decode(base);
      const doken = await realm.doken(u);
      r.addApproval({ serialize: () => doken }, new Uint8Array(64).fill(sig));
      return { bytes: new Uint8Array(r.encode()), doken, sig: new Uint8Array(64).fill(sig) };
    };
    const fromA = await approveAs(a, 1);
    const fromB = await approveAs(b, 2);

    const single = singleApprovalOn(baseInspected, inspectRequest(fromA.bytes));
    expect(typeof single).not.toBe("string");
    expect((single as Exclude<typeof single, string>).claims.vuid).toBe(a.vuid);

    // The requester adds B's approval to A's copy (the SDK's addApproval), in any order.
    const merged = BaseTideRequest.decode(fromA.bytes);
    merged.addApproval({ serialize: () => fromB.doken }, fromB.sig);
    const inspected = inspectRequest(new Uint8Array(merged.encode()));
    expect(inspected.approvals.map((x) => x.vuid)).toEqual([a.vuid, b.vuid]);
    expect(inspected.approvalSignatures.map((s) => s[0])).toEqual([1, 2]);
    expect(merged.getCurrentApprovalCount()).toBe(2);
    // Still the same request: the merge never touches the draft or the network's creation signature.
    expect(singleApprovalOn(baseInspected, inspected)).toMatch(/exactly one approval/);
  });

  it("the test network writes vault requests the SDK reads", async () => {
    const realm = await newRealm();
    const seal = BaseTideRequest.decode(fromBase64(realm.vault.draftSeal("pin")));
    expect(seal.isInitialized()).toBe(true);
    expect(seal.id()).toBe("PolicyEnabledEncryption:1");
    expect(seal.getCurrentApprovalCount()).toBe(0);
    expect(checkVaultDraft(inspectRequest(fromBase64(realm.vault.draftSeal("pin"))), { name: "PolicyEnabledEncryption", tag: VAULT_TAG, nowSeconds: now() })).toBeNull();
  });

  it("refuses garbage instead of crashing", () => {
    expect(() => inspectRequest(new Uint8Array([1, 2, 3]))).toThrow(/not a Tide request/);
  });
});
