import { describe, expect, it, vi } from "vitest";
import { makeKey, makeRequest } from "@/test/fixtures";
import { approve, finish, registerKey, requestRelease, type VaultDeps } from "./vault";

function deps(over: { commitRelease?: () => Promise<string>; finish?: () => Promise<never> } = {}) {
  const calls: string[] = [];
  const d: VaultDeps = {
    tide: {
      draftSeal: vi.fn(async () => { calls.push("tide.draftSeal"); return "SEAL_DRAFT"; }),
      draftRelease: vi.fn(async () => { calls.push("tide.draftRelease"); return "RELEASE_DRAFT"; }),
      approveRequest: vi.fn(async () => { calls.push("tide.approve"); return "MINE"; }),
      mergeApprovals: vi.fn(() => { calls.push("tide.merge"); return new Uint8Array([1]); }),
      commitSeal: vi.fn(async () => { calls.push("tide.commitSeal"); return "CIPHERTEXT"; }),
      commitRelease: vi.fn(over.commitRelease ?? (async () => { calls.push("tide.commitRelease"); return "sk_live_SECRET"; })),
    },
    api: {
      registerKey: vi.fn(async () => { calls.push("api.register"); return { key: makeKey({ status: "pending_seal" }), request: makeRequest({ operation: "seal" }) }; }),
      requestRelease: vi.fn(async () => { calls.push("api.release"); return makeRequest(); }),
      approve: vi.fn(async () => { calls.push("api.approve"); return makeRequest({ status: "ready" }); }),
      finishKit: vi.fn(async () => { calls.push("api.kit"); return { policy: "POLICY", approvals: [{ doken: "D1", signature: "S1", name: "Lê Cường" }, { doken: "D2", signature: "S2", name: "Nguyễn An" }] }; }),
      finish: vi.fn(over.finish ?? (async () => { calls.push("api.finish"); return { request: makeRequest({ status: "completed" }), key: makeKey() }; })),
    },
  };
  return { d, calls };
}

describe("vault workflow", () => {
  it("encrypts the secret in the browser before anything reaches the server, and sends only the draft", async () => {
    const { d, calls } = deps();
    await registerKey(d, { name: "Viettel MySign", kind: "digital_signature", provider: "Viettel", description: "", hint: "", level: 3 }, "PIN 123456");
    expect(calls).toEqual(["tide.draftSeal", "api.register"]);
    expect(d.tide.draftSeal).toHaveBeenCalledWith("PIN 123456");
    expect(JSON.stringify((d.api.registerKey as any).mock.calls[0][0])).not.toContain("123456");
    expect((d.api.registerKey as any).mock.calls[0][0].request).toBe("SEAL_DRAFT");
  });

  it("refuses to register without a secret", async () => {
    const { d } = deps();
    await expect(registerKey(d, { name: "x", kind: "api_key", provider: "", description: "", hint: "", level: 2 }, "")).rejects.toThrow(/secret/);
    expect(d.tide.draftSeal).not.toHaveBeenCalled();
  });

  it("asks for a key by drafting the decryption of exactly that key's ciphertext", async () => {
    const { d, calls } = deps();
    await requestRelease(d, makeKey(), "Close the old billing account");
    expect(calls).toEqual(["tide.draftRelease", "api.release"]);
    expect(d.tide.draftRelease).toHaveBeenCalledWith("Q0lQSEVSVEVYVA==");
    expect(d.api.requestRelease).toHaveBeenCalledWith("key_1", { reason: "Close the old billing account", request: "RELEASE_DRAFT" });
  });

  it("approves in Tide FIRST (no network call before the window opens), then records it", async () => {
    const { d, calls } = deps();
    await approve(d, makeRequest());
    expect(calls).toEqual(["tide.approve", "api.approve"]);
    expect(d.tide.approveRequest).toHaveBeenCalledWith("UkVRVUVTVA==");
    expect(d.api.approve).toHaveBeenCalledWith("req_1", "MINE");
  });

  it("finishing a release: own approval in Tide, then the kit, the merge, the network decrypts, the server records, and only then the secret", async () => {
    const { d, calls } = deps();
    const out = await finish(d, makeRequest({ status: "ready", approvals: [] }));
    expect(calls).toEqual(["tide.approve", "api.kit", "tide.merge", "tide.commitRelease", "api.finish"]);
    expect(d.tide.mergeApprovals).toHaveBeenCalledWith("MINE", [{ doken: "D1", signature: "S1", name: "Lê Cường" }, { doken: "D2", signature: "S2", name: "Nguyễn An" }]);
    expect(d.tide.commitRelease).toHaveBeenCalledWith(new Uint8Array([1]), "POLICY");
    expect(d.api.finish).toHaveBeenCalledWith("req_1", { request: "MINE" });
    expect(out.secret).toBe("sk_live_SECRET");
  });

  it("finishing a seal hands the server the network's ciphertext and the requester's own approval", async () => {
    const { d, calls } = deps();
    const out = await finish(d, makeRequest({ operation: "seal", status: "ready" }));
    expect(calls).toEqual(["tide.approve", "api.kit", "tide.merge", "tide.commitSeal", "api.finish"]);
    expect(d.api.finish).toHaveBeenCalledWith("req_1", { request: "MINE", ciphertext: "CIPHERTEXT" });
    expect(out.secret).toBeUndefined();
  });

  it("never returns a secret that could not be recorded on the audit log", async () => {
    const { d } = deps({ finish: async () => { throw new Error("server down"); } });
    await expect(finish(d, makeRequest({ status: "ready" }))).rejects.toThrow("server down");
  });

  it("a network refusal stops the flow before anything is recorded", async () => {
    const { d } = deps({ commitRelease: async () => { throw new Error("The Tide network refused to unlock the key"); } });
    await expect(finish(d, makeRequest({ status: "ready" }))).rejects.toThrow(/refused/);
    expect(d.api.finish).not.toHaveBeenCalled();
  });

  it("cannot finish before every approval is in", async () => {
    const { d } = deps();
    await expect(finish(d, makeRequest({ status: "collecting" }))).rejects.toThrow(/approval/);
    expect(d.tide.approveRequest).not.toHaveBeenCalled();
  });
});
