/**
 * The ONLY module that talks to the Tide SDK. Components and stores go through the flows in
 * `@/flows/vault` or the API client, never @tidecloak/js directly.
 *
 * What runs here, and why it must be the browser: every Tide operation needs the signed-in user's
 * credential, which lives in the Tide enclave in this tab. Secrets are encrypted here before they
 * leave the device, and decrypted here only after the Tide network checked the board's approvals.
 * SignGuard's server cannot approve, encrypt or decrypt on anyone's behalf.
 */
import { IAMService, Models, Tools } from "@tidecloak/js";
import adapter from "virtual:tidecloak-adapter";

export const tideConfig = adapter;

type Bytes = Uint8Array;

/** The SDK's internal client: the request/approval enclaves have no public wrapper yet. */
interface TideClient {
  createTideRequest(encodedRequest: Bytes): Promise<Bytes>;
  requestTideOperatorApproval(requests: { id: string; request: Bytes }[]): Promise<{ id: string; request: Bytes; status: "approved" | "denied" | "pending" }[]>;
  executeSignRequest(request: Bytes, waitForAll?: boolean): Promise<Bytes[]>;
  registerPopupErrorCallback?(callback: () => void): void;
}

/** Must match the backend's VAULT_TAG: every vault ciphertext carries exactly this tag. */
export const VAULT_TAG = "signguard-vault-v1";

export const toBase64 = (b: Bytes): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromBase64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function client(): TideClient {
  const tc = (IAMService as unknown as { _tc: TideClient | null })._tc;
  if (!tc) throw new TideError("not-ready", "Tide is not ready. Reload the page and sign in again.");
  return tc;
}

export class TideError extends Error {
  constructor(readonly kind: "not-ready" | "popup-blocked" | "denied" | "network", message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TideError";
  }
}

/** Turn the SDK's errors into something a person can act on; keep the network's own reason. */
function explain(e: unknown, action: string): never {
  if (e instanceof TideError) throw e;
  const raw = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: unknown })?.cause;
  const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (/popup/i.test(raw)) throw new TideError("popup-blocked", "Your browser blocked the Tide window. Allow pop-ups for SignGuard and try again.", e);
  if (/THRESHOLD_FAILURE|enough VVK ORKs|Not enough successful dokens/i.test(raw)) {
    throw new TideError("denied", `The Tide network refused to ${action}${detail ? `: ${detail}` : ": not enough board approvals."}`, e);
  }
  throw new TideError("network", `Could not ${action}: ${raw}${detail ? ` (${detail})` : ""}`, e);
}

let popupBlocked: (() => void) | null = null;
export function onPopupBlocked(cb: () => void) {
  popupBlocked = cb;
}

export async function initTide(): Promise<boolean> {
  const authenticated = await IAMService.initIAM({ ...adapter, useDPoP: { mode: "strict", alg: "ES256" } });
  try {
    client().registerPopupErrorCallback?.(() => popupBlocked?.());
  } catch {
    // Older SDKs have no popup callback; the error path still explains it.
  }
  return authenticated;
}

export const login = (returnPath?: string) => IAMService.doLogin(returnPath);
export const logout = () => IAMService.doLogout();
export const isLoggedIn = () => IAMService.isLoggedIn();
export const claim = (key: string): unknown => IAMService.getValueFromToken(key);

/** fetch with the user's token AND a DPoP proof from this device's key. URL must be absolute for the proof's htu. */
export async function secureFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await IAMService.updateIAMToken();
  const url = path.startsWith("http") ? path : `${window.location.origin}${path}`;
  return IAMService.secureFetch(url, init);
}

/** Drafts come back initialised by the network; initialise one ourselves if an SDK build did not. */
async function initialised(draft: Bytes): Promise<Bytes> {
  return Models.BaseTideRequest.decode(draft).isInitialized() ? draft : client().createTideRequest(draft);
}

/**
 * Encrypt a secret in this browser to the Tide network's key. The result holds only ciphertext;
 * the network signs it (making it usable) only once the board approves.
 */
export async function draftSeal(secret: string): Promise<string> {
  try {
    const draft = await IAMService.doDraftEncryption([{ data: new TextEncoder().encode(secret), tags: [VAULT_TAG] }]);
    return toBase64(await initialised(draft));
  } catch (e) {
    explain(e, "encrypt the key");
  }
}

/** Ask to decrypt a vault key: the network will only answer once the board has approved. */
export async function draftRelease(ciphertextB64: string): Promise<string> {
  try {
    const draft = await IAMService.doDraftDecryption([{ encrypted: fromBase64(ciphertextB64), tags: [VAULT_TAG] }]);
    return toBase64(await initialised(draft));
  } catch (e) {
    explain(e, "prepare the request");
  }
}

/**
 * The person confirms in Tide's own window, which shows the request independently of this page.
 * Returns the request carrying their approval. Call straight from the click: no awaits before it.
 */
export async function approveRequest(requestB64: string): Promise<string> {
  try {
    const bytes = fromBase64(requestB64);
    const id = Models.BaseTideRequest.decode(bytes).getUniqueId();
    const [result] = await client().requestTideOperatorApproval([{ id, request: bytes }]);
    if (!result || result.status !== "approved") throw new TideError("denied", result?.status === "denied" ? "You declined in the Tide window." : "The Tide window closed without approving.");
    return toBase64(result.request);
  } catch (e) {
    explain(e, "approve");
  }
}

/**
 * Add the other board members' approvals to the requester's own. Each approval signs only the
 * request's creation, never the other approvals, so they merge in any order.
 */
export function mergeApprovals(ownB64: string, approvals: { doken: string; signature: string }[]): Bytes {
  const request = Models.BaseTideRequest.decode(fromBase64(ownB64));
  for (const a of approvals) request.addApproval(new Models.Doken(a.doken), fromBase64(a.signature));
  return request.encode();
}

/** With every approval in, the network checks them against the policy and signs the ciphertext. */
export async function commitSeal(merged: Bytes, policyB64: string): Promise<string> {
  try {
    const [ciphertext] = await IAMService.doCommitEncryption(merged, fromBase64(policyB64));
    if (!ciphertext) throw new TideError("network", "The Tide network returned no ciphertext.");
    return toBase64(ciphertext);
  } catch (e) {
    explain(e, "seal the key");
  }
}

/** With every approval in, the network checks them against the policy and decrypts, to this browser only. */
export async function commitRelease(merged: Bytes, policyB64: string): Promise<string> {
  try {
    const [plain] = await IAMService.doCommitDecryption(merged, fromBase64(policyB64));
    if (!plain) throw new TideError("network", "The Tide network returned nothing.");
    return new TextDecoder().decode(plain);
  } catch (e) {
    explain(e, "unlock the key");
  }
}

/**
 * A realm admin signs a vault policy under the realm's admin policy. Opens Tide's approval window:
 * call it straight from a click. Same sequence as Tide's verified relationship-attestation helper.
 */
export async function signPolicyAsAdmin(unsignedPolicyB64: string, adminPolicyB64: string): Promise<string> {
  try {
    const request = new Models.BaseTideRequest("Policy", "1", "Policy:1", Tools.TideMemory.CreateFromArray([fromBase64(unsignedPolicyB64)]));
    request.setCustomExpiry(7 * 24 * 3600);
    const ready = await client().createTideRequest(request.encode());
    const id = Models.BaseTideRequest.decode(ready).getUniqueId();
    const [approval] = await client().requestTideOperatorApproval([{ id, request: ready }]);
    if (!approval || approval.status !== "approved") throw new TideError("denied", `The policy was not approved (${approval?.status ?? "no answer"}).`);
    const approved = Models.BaseTideRequest.decode(approval.request);
    approved.addPolicy(fromBase64(adminPolicyB64));
    const [signature] = await client().executeSignRequest(approved.encode(), true);
    if (!signature) throw new TideError("network", "The Tide network returned no signature.");
    return toBase64(signature);
  } catch (e) {
    explain(e, "sign the policy");
  }
}
