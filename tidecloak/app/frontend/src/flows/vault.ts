import type { NewKeyInput } from "@/api/client";
import type { FinishKit, KeyRequest, VaultKey } from "@/api/types";

/**
 * The vault workflow, as plain functions over injected dependencies so the exact order of Tide and
 * API calls is unit-tested (src/flows/vault.test.ts).
 *
 *   register:  draftSeal (encrypt in this browser)        -> server stores the draft, opens a seal request
 *   ask:       draftRelease (for this key's ciphertext)   -> server checks it is this key, opens a release request
 *   approve:   approveRequest (Tide window)               -> server checks exactly one new approval, theirs
 *   finish:    approveRequest (requester, Tide window) -> finish kit -> merge -> network seals or decrypts
 *              -> server records it. A released secret is shown only once the release is on the audit log.
 */
export interface VaultDeps {
  tide: {
    draftSeal(secret: string): Promise<string>;
    draftRelease(ciphertextB64: string): Promise<string>;
    approveRequest(requestB64: string): Promise<string>;
    mergeApprovals(ownB64: string, approvals: { doken: string; signature: string }[]): Uint8Array;
    commitSeal(merged: Uint8Array, policyB64: string): Promise<string>;
    commitRelease(merged: Uint8Array, policyB64: string): Promise<string>;
  };
  api: {
    registerKey(input: NewKeyInput): Promise<{ key: VaultKey; request: KeyRequest }>;
    requestRelease(keyId: string, body: { reason: string; request: string }): Promise<KeyRequest>;
    approve(id: string, request: string): Promise<KeyRequest>;
    finishKit(id: string): Promise<FinishKit>;
    finish(id: string, body: { request: string; ciphertext?: string }): Promise<{ request: KeyRequest; key: VaultKey }>;
  };
}

export type Step = "encrypting" | "approving" | "collecting" | "sealing" | "unlocking" | "recording" | "done";

export const STEP_TEXT: Record<Step, string> = {
  encrypting: "Encrypting in this browser with Tide…",
  approving: "Confirm in the Tide window that just opened…",
  collecting: "Collecting the board's approvals…",
  sealing: "The Tide network is checking the approvals and sealing the key…",
  unlocking: "The Tide network is checking the approvals and decrypting, to this browser only…",
  recording: "Recording it on the audit log…",
  done: "Done.",
};

/** A board member puts a key in the vault. The secret is encrypted before anything leaves the browser. */
export async function registerKey(
  d: VaultDeps, meta: Omit<NewKeyInput, "request">, secret: string, onStep: (s: Step) => void = () => {},
): Promise<{ key: VaultKey; request: KeyRequest }> {
  if (!secret) throw new Error("Enter the secret to protect.");
  onStep("encrypting");
  const request = await d.tide.draftSeal(secret);
  onStep("recording");
  const out = await d.api.registerKey({ ...meta, request });
  onStep("done");
  return out;
}

/** Ask the board for a key. The decryption is drafted for exactly this key's ciphertext. */
export async function requestRelease(d: VaultDeps, key: VaultKey, reason: string, onStep: (s: Step) => void = () => {}): Promise<KeyRequest> {
  if (key.status !== "active" || !key.ciphertext) throw new Error("This key is not in the vault.");
  onStep("encrypting");
  const request = await d.tide.draftRelease(key.ciphertext);
  onStep("recording");
  const out = await d.api.requestRelease(key.id, { reason, request });
  onStep("done");
  return out;
}

/** Another board member approves. Tide's window opens first, straight from the click. */
export async function approve(d: VaultDeps, req: KeyRequest, onStep: (s: Step) => void = () => {}): Promise<KeyRequest> {
  onStep("approving");
  const approved = await d.tide.approveRequest(req.tideRequest);
  onStep("recording");
  const out = await d.api.approve(req.id, approved);
  onStep("done");
  return out;
}

export interface FinishResult {
  request: KeyRequest;
  key: VaultKey;
  /** Release only: the secret, decrypted in this browser. */
  secret?: string;
}

/**
 * The requester finishes: approves in Tide (the window opens straight from the click), merges the
 * others' approvals, and the network seals or decrypts. Nothing is shown unless it was recorded.
 */
export async function finish(d: VaultDeps, req: KeyRequest, onStep: (s: Step) => void = () => {}): Promise<FinishResult> {
  if (req.status !== "ready") throw new Error("Not every approval is in yet.");
  onStep("approving");
  const own = await d.tide.approveRequest(req.tideRequest);
  onStep("collecting");
  const kit = await d.api.finishKit(req.id);
  const merged = d.tide.mergeApprovals(own, kit.approvals);
  if (req.operation === "seal") {
    onStep("sealing");
    const ciphertext = await d.tide.commitSeal(merged, kit.policy);
    onStep("recording");
    const out = await d.api.finish(req.id, { request: own, ciphertext });
    onStep("done");
    return out;
  }
  onStep("unlocking");
  const secret = await d.tide.commitRelease(merged, kit.policy);
  onStep("recording");
  const out = await d.api.finish(req.id, { request: own });
  onStep("done");
  return { ...out, secret };
}
