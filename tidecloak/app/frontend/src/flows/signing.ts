import type { SigningRequest } from "@/api/types";

/**
 * The approval workflow, as plain functions over injected dependencies so the exact order of
 * Tide and API calls is unit-tested (src/flows/signing.test.ts).
 *
 *   drafter:   submit -> openOnTide (createTideRequest) -> server checks it carries this statement
 *   approver:  approveSigningRequest (Tide window) -> server checks exactly one new approval, theirs
 *   last one:  executeSigningRequest (network checks the quorum, signs) -> server verifies signature
 */
export interface SigningDeps {
  tide: {
    openSigningRequest(statementB64: string): Promise<string>;
    approveSigningRequest(requestB64: string): Promise<string>;
    executeSigningRequest(requestB64: string, signingRuleB64: string): Promise<string>;
  };
  api: {
    openOnTide(id: string, request: string): Promise<SigningRequest>;
    approve(id: string, contentHash: string, body: { request?: string; baseVersion?: number }): Promise<SigningRequest>;
    recordSignature(id: string, signature: string): Promise<{ request: SigningRequest }>;
  };
}

export type Step = "opening" | "approving" | "recording" | "signing" | "done";

/** Right after submit: put the request on the Tide network so approvers can sign it. */
export async function openRequest(d: SigningDeps, req: SigningRequest): Promise<SigningRequest> {
  if (req.mode !== "tide" || req.tideRequest) return req;
  return d.api.openOnTide(req.id, await d.tide.openSigningRequest(req.statement));
}

/**
 * Approve, then sign if this approval completes the quorum. `req` must already hold the Tide
 * request bytes (prefetched), so the Tide window opens directly from the click without an await
 * in front of it, and pop-up blockers let it through.
 */
export async function approveAndMaybeSign(
  d: SigningDeps, req: SigningRequest, signingRule: string | null, onStep: (s: Step) => void = () => {},
): Promise<SigningRequest> {
  if (req.mode === "unsigned-dev") {
    onStep("recording");
    const out = await d.api.approve(req.id, req.contentHash, {});
    onStep("done");
    return out;
  }
  if (!req.tideRequest) throw new Error("This request is not open on Tide yet. Reload and try again.");
  onStep("approving");
  const approved = await d.tide.approveSigningRequest(req.tideRequest);
  onStep("recording");
  const after = await d.api.approve(req.id, req.contentHash, { request: approved, baseVersion: req.tideRequestVersion });
  if (after.status === "quorum_met") return finishSigning(d, after, signingRule, onStep);
  onStep("done");
  return after;
}

/** Ask the network to sign a request whose approvals are complete, and record the signature. */
export async function finishSigning(
  d: SigningDeps, req: SigningRequest, signingRule: string | null, onStep: (s: Step) => void = () => {},
): Promise<SigningRequest> {
  if (req.status !== "quorum_met" || req.mode !== "tide") return req;
  if (!req.tideRequest || !signingRule) throw new Error("The network rule for this request is missing. Ask a realm admin to check Tide setup.");
  onStep("signing");
  const signature = await d.tide.executeSigningRequest(req.tideRequest, signingRule);
  const { request } = await d.api.recordSignature(req.id, signature);
  onStep("done");
  return request;
}
