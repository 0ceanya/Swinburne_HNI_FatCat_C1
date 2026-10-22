import { describe, expect, it, vi } from "vitest";
import { makeRequest } from "@/test/fixtures";
import { approveAndMaybeSign, finishSigning, openRequest, type SigningDeps } from "./signing";

function deps(afterApproveStatus: "collecting" | "quorum_met") {
  const calls: string[] = [];
  const d: SigningDeps = {
    tide: {
      openSigningRequest: vi.fn(async (s: string) => { calls.push(`tide.open(${s})`); return "INIT"; }),
      approveSigningRequest: vi.fn(async (r: string) => { calls.push(`tide.approve(${r})`); return "APPROVED"; }),
      executeSigningRequest: vi.fn(async (r: string, rule: string) => { calls.push(`tide.execute(${r},${rule})`); return "SIG"; }),
    },
    api: {
      openOnTide: vi.fn(async (id: string, r: string) => { calls.push(`api.open(${id},${r})`); return makeRequest({ tideRequest: r }); }),
      approve: vi.fn(async (id: string, hash: string, body) => {
        calls.push(`api.approve(${id},${hash.slice(0, 4)},${body.request ?? "-"},${body.baseVersion ?? "-"})`);
        return makeRequest({ status: afterApproveStatus, tideRequest: body.request ?? null });
      }),
      recordSignature: vi.fn(async (id: string, sig: string) => { calls.push(`api.signature(${id},${sig})`); return { request: makeRequest({ status: "signed" }) }; }),
    },
  };
  return { d, calls };
}

describe("signing workflow", () => {
  it("opens the request on Tide right after submit, then hands the server the initialised bytes", async () => {
    const { d, calls } = deps("collecting");
    await openRequest(d, makeRequest({ tideRequest: null, statement: "STMT" }));
    expect(calls).toEqual(["tide.open(STMT)", "api.open(req_1,INIT)"]);
  });

  it("does not re-open a request that is already on Tide", async () => {
    const { d, calls } = deps("collecting");
    await openRequest(d, makeRequest());
    expect(calls).toEqual([]);
  });

  it("approves in Tide FIRST (no network call before the window opens), then records it", async () => {
    const { d, calls } = deps("collecting");
    const out = await approveAndMaybeSign(d, makeRequest(), "RULE");
    expect(calls).toEqual(["tide.approve(UkVRVUVTVA==)", "api.approve(req_1,3f9a,APPROVED,2)"]);
    expect(out.status).toBe("collecting");
  });

  it("when this approval completes the quorum, asks the network to sign and records the signature", async () => {
    const { d, calls } = deps("quorum_met");
    const steps: string[] = [];
    await approveAndMaybeSign(d, makeRequest(), "RULE", (s) => steps.push(s));
    expect(calls).toEqual(["tide.approve(UkVRVUVTVA==)", "api.approve(req_1,3f9a,APPROVED,2)", "tide.execute(APPROVED,RULE)", "api.signature(req_1,SIG)"]);
    expect(steps).toEqual(["approving", "recording", "signing", "done"]);
  });

  it("refuses to approve a request that is not on Tide yet, rather than inventing bytes", async () => {
    const { d, calls } = deps("collecting");
    await expect(approveAndMaybeSign(d, makeRequest({ tideRequest: null }), "RULE")).rejects.toThrow(/not open on Tide/);
    expect(calls).toEqual([]);
  });

  it("needs the network rule to finish signing", async () => {
    const { d } = deps("quorum_met");
    await expect(finishSigning(d, makeRequest({ status: "quorum_met" }), null)).rejects.toThrow(/network rule/);
  });

  it("dev mode approves without Tide and is never asked to sign", async () => {
    const { d, calls } = deps("collecting");
    await approveAndMaybeSign(d, makeRequest({ mode: "unsigned-dev", tideRequest: null }), null);
    expect(calls).toEqual(["api.approve(req_1,3f9a,-,-)"]);
  });

  it("a Tide refusal stops the flow before anything is recorded", async () => {
    const { d, calls } = deps("collecting");
    (d.tide.approveSigningRequest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("You declined in the Tide window."));
    await expect(approveAndMaybeSign(d, makeRequest(), "RULE")).rejects.toThrow(/declined/);
    expect(calls).toEqual([]);
  });
});
