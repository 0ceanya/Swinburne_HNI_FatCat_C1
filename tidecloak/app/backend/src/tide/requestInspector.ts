import { equalBytes, entries, fromUtf8, getValue, tryGetValue } from "../lib/tideMemory.js";
import { parseDoken, type DokenClaims } from "./signatures.js";

/**
 * Reads a Tide request (the bytes the browser SDK passes between drafting, Tide's approval window and
 * committing) so the server can check what it is being asked to accept. Field layout of @tideorg/js
 * `BaseTideRequest.encode()`:
 *
 *   0 name  1 version  2 expiry (int64 LE)  3 draft  4 authFlow  5 dynamicData
 *   6 authorizer (approver dokens)  7 authorization ([creationTime, creationSig], [approval sigs])
 *   8 authorizerCert (for vault drafts: the ciphertext, kept for the commit step)  9 policy
 *
 * Each approval is the approver's session-key signature over the creation message and the
 * network's creation signature, so it does not depend on any other approval: approvals collected
 * separately can be merged in any order (BaseTideRequest.addApproval).
 */
export interface InspectedRequest {
  name: string;
  version: string;
  authFlow: string;
  expiry: number;
  draft: Uint8Array;
  creationTime: Uint8Array;
  creationSignature: Uint8Array;
  initialized: boolean;
  /** Raw doken strings, in approval order. */
  dokens: string[];
  approvals: DokenClaims[];
  approvalSignatures: Uint8Array[];
  authorizerCert: Uint8Array;
  policy: Uint8Array;
}

function readInt64LE(b: Uint8Array): number {
  if (b.length !== 8) throw new RangeError("expected an 8-byte integer");
  const v = new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true);
  return Number(v);
}

export class RequestFormatError extends Error {}

export function inspectRequest(bytes: Uint8Array): InspectedRequest {
  try {
    const authorizer = getValue(bytes, 6);
    const authorization = getValue(bytes, 7);
    const creation = tryGetValue(authorization, 0);
    const creationTime = (creation && tryGetValue(creation, 0)) ?? new Uint8Array(0);
    const creationSignature = (creation && tryGetValue(creation, 1)) ?? new Uint8Array(0);
    const initialized = creationTime.length > 0 && creationSignature.length === 64;

    const sigSection = tryGetValue(authorization, 1);
    const approvalSignatures = sigSection ? entries(sigSection).filter((s) => s.length > 0) : [];

    // The SDK writes approvals as a container of doken strings. Anything that does not parse as a
    // doken is not an approval.
    const dokens = authorizer.length >= 4 ? entries(authorizer).map(fromUtf8).filter((d) => d.length > 0) : [];
    const approvals = dokens.map(parseDoken);
    if (approvals.some((a) => a === null)) throw new RequestFormatError("authorizer holds something that is not a doken");

    return {
      name: fromUtf8(getValue(bytes, 0)),
      version: fromUtf8(getValue(bytes, 1)),
      expiry: readInt64LE(getValue(bytes, 2)),
      draft: getValue(bytes, 3),
      authFlow: fromUtf8(getValue(bytes, 4)),
      creationTime,
      creationSignature,
      initialized,
      dokens,
      approvals: approvals as DokenClaims[],
      approvalSignatures,
      authorizerCert: tryGetValue(bytes, 8) ?? new Uint8Array(0),
      policy: tryGetValue(bytes, 9) ?? new Uint8Array(0),
    };
  } catch (e) {
    if (e instanceof RequestFormatError) throw e;
    throw new RequestFormatError(`not a Tide request: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The request model of a vault operation, as BaseTideRequest names it. */
export type VaultRequestName = "PolicyEnabledEncryption" | "PolicyEnabledDecryption";

/** One encrypted value inside a vault draft. */
export interface DraftEntry {
  /** ElGamal C1 point of the value (or of its data key, for values of 32 bytes or more). */
  c1: Uint8Array;
  /** Decryption drafts: the network's signature over the ciphertext. Empty for encryption drafts. */
  signature: Uint8Array;
  /** 8-byte timestamp the ciphertext was made at. */
  timestamp: Uint8Array;
  tags: string[];
}

/**
 * Read the single entry of a vault draft.
 *   encryption draft: [timestamp, [C1, authData, ...tags]]
 *   decryption draft: [[C1, signature, timestamp, ...tags]]
 */
export function readDraftEntry(name: VaultRequestName, draft: Uint8Array): DraftEntry {
  const items = entries(draft);
  if (name === "PolicyEnabledEncryption") {
    if (items.length !== 2) throw new RequestFormatError("a vault seal must encrypt exactly one value");
    const [timestamp, entry] = items as [Uint8Array, Uint8Array];
    const parts = entries(entry);
    if (parts.length < 3) throw new RequestFormatError("encryption entry is incomplete");
    return { c1: parts[0]!, signature: new Uint8Array(0), timestamp, tags: parts.slice(2).map(fromUtf8) };
  }
  if (items.length !== 1) throw new RequestFormatError("a vault release must decrypt exactly one value");
  const parts = entries(items[0]!);
  if (parts.length < 4) throw new RequestFormatError("decryption entry is incomplete");
  return { c1: parts[0]!, signature: parts[1]!, timestamp: parts[2]!, tags: parts.slice(3).map(fromUtf8) };
}

/**
 * A freshly drafted vault request: the right model, initialised by the network, no approvals yet,
 * one value tagged for the vault, the ciphertext kept for the commit step. Returns a reason on failure.
 */
export function checkVaultDraft(r: InspectedRequest, expected: { name: VaultRequestName; tag: string; nowSeconds: number }): string | null {
  if (r.name !== expected.name || r.version !== "1" || r.authFlow !== "Policy:1") return "wrong request model";
  if (!r.initialized) return "request was not initialised by the Tide network";
  if (r.expiry <= expected.nowSeconds) return "request has expired";
  if (r.dokens.length !== 0 || r.approvalSignatures.length !== 0) return "a new request cannot already carry approvals";
  if (r.authorizerCert.length === 0) return "request is missing its ciphertext";
  let entry: DraftEntry;
  try { entry = readDraftEntry(expected.name, r.draft); } catch (e) { return e instanceof Error ? e.message : "unreadable draft"; }
  if (entry.c1.length !== 32) return "draft value is not an ElGamal ciphertext";
  if (entry.tags.length !== 1 || entry.tags[0] !== expected.tag) return `the value must carry exactly the tag ${expected.tag}`;
  return null;
}

/** Same request: model, expiry, draft and the network's creation signature all identical. */
export function sameRequest(a: InspectedRequest, b: InspectedRequest): boolean {
  return a.name === b.name && a.version === b.version && a.authFlow === b.authFlow && a.expiry === b.expiry
    && equalBytes(a.draft, b.draft) && equalBytes(a.creationTime, b.creationTime) && equalBytes(a.creationSignature, b.creationSignature);
}

export interface SingleApproval {
  doken: string;
  claims: DokenClaims;
  signature: Uint8Array;
}

/**
 * What an approver hands back must be the stored request plus exactly one approval: theirs.
 * Returns that approval, or a reason.
 */
export function singleApprovalOn(base: InspectedRequest, after: InspectedRequest): SingleApproval | string {
  if (!sameRequest(base, after)) return "these bytes are not the request you were shown";
  if (base.dokens.length !== 0) return "the stored request already carries approvals";
  if (after.dokens.length !== 1 || after.approvalSignatures.length !== 1) return "the request must carry exactly one approval";
  if (after.approvalSignatures[0]!.length !== 64) return "the approval signature is malformed";
  return { doken: after.dokens[0]!, claims: after.approvals[0]!, signature: after.approvalSignatures[0]! };
}
