import { equalBytes, entries, fromUtf8, getValue, tryGetValue } from "../lib/tideMemory.js";
import { parseDoken, type DokenClaims } from "./signatures.js";

/**
 * Reads a Tide request (the bytes the browser SDK passes between createTideRequest,
 * requestTideOperatorApproval and executeSignRequest) so the server can check what it is being
 * asked to accept. Field layout of @tideorg/js `BaseTideRequest.encode()`:
 *
 *   0 name  1 version  2 expiry (int64 LE)  3 draft  4 authFlow  5 dynamicData
 *   6 authorizer (approver dokens)  7 authorization ([creation], [approval sigs])
 *   8 authorizerCert  9 policy
 */
export interface InspectedRequest {
  name: string;
  version: string;
  authFlow: string;
  expiry: number;
  draft: Uint8Array;
  initialized: boolean;
  /** Raw doken strings, in approval order. */
  dokens: string[];
  approvals: DokenClaims[];
  approvalSignatureCount: number;
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
    const creationTime = creation && tryGetValue(creation, 0);
    const creationSig = creation && tryGetValue(creation, 1);
    const initialized = !!creationTime && creationTime.length > 0 && !!creationSig && creationSig.length === 64;

    const sigSection = tryGetValue(authorization, 1);
    const approvalSignatureCount = sigSection ? entries(sigSection).filter((s) => s.length > 0).length : 0;

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
      initialized,
      dokens,
      approvals: approvals as DokenClaims[],
      approvalSignatureCount,
      policy: getValue(bytes, 9),
    };
  } catch (e) {
    if (e instanceof RequestFormatError) throw e;
    throw new RequestFormatError(`not a Tide request: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ExpectedRequest {
  /** The unsigned policy the request must carry as draft[0]. */
  unsignedPolicy: Uint8Array;
  nowSeconds: number;
}

/**
 * The request must be a "sign this policy" request for exactly the expected policy, initialised,
 * and not expired. Returns a reason on failure.
 */
export function checkRequestShape(r: InspectedRequest, expected: ExpectedRequest): string | null {
  if (r.name !== "Policy" || r.version !== "1" || r.authFlow !== "Policy:1") return "wrong request model";
  const draft0 = tryGetValue(r.draft, 0);
  if (!draft0 || !equalBytes(draft0, expected.unsignedPolicy)) return "request does not carry this document's approval statement";
  if (!r.initialized) return "request was not initialised by the Tide network";
  if (r.expiry <= expected.nowSeconds) return "request has expired";
  if (r.approvalSignatureCount !== r.approvals.length) return "approval signatures and approvers do not line up";
  return null;
}
