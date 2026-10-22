/**
 * The ONLY module that talks to the Tide SDK. Components and stores go through `useTide()` or the
 * API client, never @tidecloak/js directly.
 *
 * What runs here, and why it must be the browser: every Tide operation needs the signed-in user's
 * credential, which lives in the Tide enclave in this tab. A server cannot approve, sign, encrypt
 * or decrypt on anyone's behalf.
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

const SIGN_REQUEST_EXPIRY_SECONDS = 7 * 24 * 3600;
/** Must match the backend's SEALED_ASSIGNMENT_ID: the only tag RelationshipAttestation:1 accepts. */
export const SEALED_TAG = "signguard-sealed-v1";

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
  if (/THRESHOLD_FAILURE|enough VVK ORKs/i.test(raw)) {
    throw new TideError("denied", `The Tide network refused to ${action}${detail ? `: ${detail}` : "."}`, e);
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
export const refreshToken = () => IAMService.forceUpdateToken();

/** fetch with the user's token AND a DPoP proof from this device's key. URL must be absolute for the proof's htu. */
export async function secureFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await IAMService.updateIAMToken();
  const url = path.startsWith("http") ? path : `${window.location.origin}${path}`;
  return IAMService.secureFetch(url, init);
}

const policyRequest = (unsignedPolicyB64: string) => {
  const request = new Models.BaseTideRequest("Policy", "1", "Policy:1", Tools.TideMemory.CreateFromArray([fromBase64(unsignedPolicyB64)]));
  request.setCustomExpiry(SIGN_REQUEST_EXPIRY_SECONDS);
  return request;
};

/**
 * A realm admin signs a policy (a network rule, or the sealed-fields policy) under the realm's
 * admin policy. Opens Tide's approval window: call it straight from a click.
 * Same sequence as Tide's verified relationship-attestation helper.
 */
export async function signPolicyAsAdmin(unsignedPolicyB64: string, adminPolicyB64: string): Promise<string> {
  try {
    const initialised = await client().createTideRequest(policyRequest(unsignedPolicyB64).encode());
    const id = Models.BaseTideRequest.decode(initialised).getUniqueId();
    const [approval] = await client().requestTideOperatorApproval([{ id, request: initialised }]);
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

/** Open a document's approval statement on the Tide network (no window opens). */
export async function openSigningRequest(statementB64: string): Promise<string> {
  try {
    return toBase64(await client().createTideRequest(policyRequest(statementB64).encode()));
  } catch (e) {
    explain(e, "open the request on Tide");
  }
}

/**
 * The approver confirms in Tide's own window, which shows the request independently of this page.
 * Returns the request carrying their approval. Call straight from the click: no awaits before it.
 */
export async function approveSigningRequest(requestB64: string): Promise<string> {
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

/** With the approvals in, ask the network to sign; its contract checks them again first. */
export async function executeSigningRequest(requestB64: string, signingRuleB64: string): Promise<string> {
  try {
    const request = Models.BaseTideRequest.decode(fromBase64(requestB64));
    request.addPolicy(fromBase64(signingRuleB64));
    const [signature] = await client().executeSignRequest(request.encode(), true);
    if (!signature) throw new TideError("network", "The Tide network returned no signature.");
    return toBase64(signature);
  } catch (e) {
    explain(e, "sign");
  }
}

/** Sealed fields: encrypted in this browser under the org's RelationshipAttestation policy. */
export async function sealValues(values: string[], sealedPolicyB64: string): Promise<string[]> {
  if (values.length === 0) return [];
  try {
    const out = await IAMService.doEncrypt(values.map((data) => ({ data, tags: [SEALED_TAG] })), fromBase64(sealedPolicyB64));
    return out.map((v) => (typeof v === "string" ? v : toBase64(v)));
  } catch (e) {
    explain(e, "encrypt");
  }
}

export async function unsealValues(ciphertexts: string[], sealedPolicyB64: string): Promise<string[]> {
  if (ciphertexts.length === 0) return [];
  try {
    const out = await IAMService.doDecrypt(ciphertexts.map((encrypted) => ({ encrypted, tags: [SEALED_TAG] })), fromBase64(sealedPolicyB64));
    return out.map((v) => (typeof v === "string" ? v : new TextDecoder().decode(v)));
  } catch (e) {
    explain(e, "decrypt");
  }
}

/**
 * Approve one TideCloak governance change (a role grant, a new member) as a realm admin, in Tide's
 * window, straight from this browser with the admin's OWN token. The request never passes through
 * SignGuard's server (Tide's guidance: an admin approval goes browser → TideCloak).
 *
 *   POST .../iga/change-requests/{id}/approve {}                      → needs-approval + requestModel
 *   Tide window signs the requestModel
 *   POST .../iga/change-requests/{id}/approve { requestModel: signed } → recorded (+ committed at quorum)
 */
export async function approveChangeRequest(changeRequestId: string): Promise<{ committed: boolean }> {
  const base = String(adapter["auth-server-url"]).replace(/\/+$/, "");
  const url = `${base}/admin/realms/${adapter.realm}/iga/change-requests/${encodeURIComponent(changeRequestId)}/approve`;
  const post = async (body: unknown) => {
    const res = await secureFetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) throw new TideError("network", `TideCloak refused the approval (HTTP ${res.status}): ${String(json.message ?? json.error ?? text).slice(0, 200)}`);
    return json;
  };
  try {
    let reply = await post({});
    if (reply.mode === "needs-approval" && typeof reply.requestModel === "string") {
      const [result] = await client().requestTideOperatorApproval([{ id: changeRequestId, request: fromBase64(reply.requestModel) }]);
      if (!result || result.status !== "approved") throw new TideError("denied", result?.status === "denied" ? "You declined in the Tide window." : "The Tide window closed without approving.");
      reply = await post({ requestModel: toBase64(result.request) });
    }
    return { committed: reply.committed === true || reply.status === "APPROVED" };
  } catch (e) {
    explain(e, "approve the change");
  }
}

/** Account API, with the user's own (DPoP-bound) token: a user editing themselves is not governed. */
export async function updateOwnProfile(fields: { firstName: string; lastName: string }): Promise<void> {
  const base = String(adapter["auth-server-url"]).replace(/\/+$/, "");
  const res = await secureFetch(`${base}/realms/${adapter.realm}/account/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(fields),
  });
  if (res.status === 202) throw new Error("Your change was queued for approval and is not saved yet.");
  if (res.status === 401 || res.status === 403) throw new Error("Not allowed to update your profile (check the token has the `account` audience).");
  if (!res.ok) throw new Error(`Could not save your details (HTTP ${res.status}).`);
  await refreshToken();
}
