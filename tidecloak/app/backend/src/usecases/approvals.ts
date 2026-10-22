import { DomainError, notFound } from "../domain/errors.js";
import type { SignatureReceipt } from "../domain/document.js";
import type { ApprovalProof, SigningRequest } from "../domain/signingRequest.js";
import { fromBase64, toBase64 } from "../lib/encoding.js";
import { parsePolicy } from "../tide/policyBytes.js";
import { checkRequestShape, inspectRequest, RequestFormatError } from "../tide/requestInspector.js";
import { verifyDoken, verifyRealmSignature } from "../tide/signatures.js";
import { actorOf, identityOf, nowIso, nowSeconds, requireMember, type Deps, type Principal } from "./context.js";
import { expireRequest } from "./documents.js";

function load(d: Deps, id: string): SigningRequest {
  const req = d.requests.get(id);
  if (!req) throw notFound("Signing request");
  if (req.expireIfDue(nowIso(d))) {
    expireRequest(d, req);
    throw new DomainError("EXPIRED", "This request has expired; the document is back in Draft");
  }
  return req;
}

function decodeB64(s: unknown, what: string): Uint8Array {
  try {
    return fromBase64(String(s ?? ""));
  } catch {
    throw new DomainError("INVALID_ENCODING", `${what} must be base64`, 400);
  }
}

function inspect(bytes: Uint8Array) {
  try {
    return inspectRequest(bytes);
  } catch (e) {
    throw new DomainError("INVALID_TIDE_REQUEST", e instanceof RequestFormatError ? e.message : "Not a Tide request", 422);
  }
}

/** Log refused attempts too: in the Đồng Tháp replay, the refusal itself is the evidence. */
function logRefusal(d: Deps, p: Principal, req: SigningRequest, e: unknown) {
  if (e instanceof DomainError && ["INITIATOR_CANNOT_APPROVE", "INELIGIBLE_TIER", "MISSING_NETWORK_ROLE"].includes(e.code)) {
    d.audit.append({ at: nowIso(d), event: "signing.denied_attempt", actor: actorOf(p), documentId: req.documentId,
      contentHash: req.contentHash, details: { requestId: req.id, code: e.code } });
  }
}

export class ListPendingApprovals {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    requireMember(p);
    const open = this.d.requests.list({ status: ["collecting", "quorum_met"] }).filter((r) => {
      if (r.expireIfDue(nowIso(this.d))) { expireRequest(this.d, r); return false; }
      return true;
    });
    const me = identityOf(p);
    return {
      waitingForMe: open.filter((r) => {
        if (r.status !== "collecting" || r.approvals.some((a) => a.memberId === p.id)) return false;
        try { r.checkCanApprove(me, nowIso(this.d)); return true; } catch { return false; }
      }),
      readyToSign: open.filter((r) => r.status === "quorum_met" && r.mode === "tide"),
      mine: open.filter((r) => r.isInitiator(me)),
    };
  }
}

export class GetSigningRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    requireMember(p);
    const req = this.d.requests.get(id);
    if (!req) throw notFound("Signing request");
    if (req.expireIfDue(nowIso(this.d))) expireRequest(this.d, req);
    const rule = this.d.tidePolicies.get("signing-rule", `${req.requirement.policyVersion}:${req.requirement.ruleId}`);
    return { request: req, signingRule: rule?.signed ?? null };
  }
}

/**
 * The first browser to open the request asks the Tide network to initialise it
 * (createTideRequest). The server checks it really is a request for THIS statement before storing.
 */
export class InitializeTideRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string, requestB64: string) {
    requireMember(p);
    const req = load(this.d, id);
    if (req.mode !== "tide") throw new DomainError("NOT_TIDE_MODE", "This request is not signed by the Tide network", 409);
    if (!req.isInitiator(identityOf(p)) && !req.isEligibleApprover(identityOf(p))) {
      throw new DomainError("INELIGIBLE_TIER", "Only the drafter or an approver can open this request with Tide", 403);
    }
    if (req.tideRequest) throw new DomainError("ALREADY_INITIALIZED", "This request is already open on the Tide network");
    const bytes = decodeB64(requestB64, "request");
    const inspected = inspect(bytes);
    const problem = checkRequestShape(inspected, { unsignedPolicy: fromBase64(req.statement), nowSeconds: nowSeconds(this.d) });
    if (problem) throw new DomainError("INVALID_TIDE_REQUEST", problem, 422);
    if (inspected.approvals.length !== 0) throw new DomainError("INVALID_TIDE_REQUEST", "A new request cannot already carry approvals", 422);
    return this.d.transaction(() => {
      req.setTideRequest(requestB64, 0, nowIso(this.d));
      this.d.requests.save(req);
      this.d.audit.append({ at: nowIso(this.d), event: "signing.initialized", actor: actorOf(p), documentId: req.documentId,
        contentHash: req.contentHash, details: { requestId: req.id, expiry: inspected.expiry } });
      return req;
    });
  }
}

export interface ApproveInput {
  /** The hash the approver was shown, taken from the URL so the device's DPoP proof covers it too. */
  contentHash: string;
  /** Tide mode: the request bytes returned by the approval enclave, now carrying this approval. */
  request?: string;
  baseVersion?: number;
}

export class ApproveRequest {
  constructor(private d: Deps) {}

  async execute(p: Principal, id: string, input: ApproveInput) {
    requireMember(p);
    const req = load(this.d, id);
    if (input.contentHash !== req.contentHash) {
      throw new DomainError("HASH_MISMATCH", "The document changed since you opened it. Reload before approving.", 409);
    }
    const me = identityOf(p);
    const now = nowIso(this.d);

    try {
      req.checkCanApprove(me, now);
      if (req.mode === "tide" && !p.realmRoles.includes(req.requirement.network.role)) {
        throw new DomainError("MISSING_NETWORK_ROLE",
          `The Tide network counts approvals from holders of ${req.requirement.network.role}, and you do not hold it`, 403);
      }
    } catch (e) {
      logRefusal(this.d, p, req, e);
      throw e;
    }

    let proof: ApprovalProof = { kind: "dev-unsigned", deviceKey: p.deviceKey ?? undefined };
    if (req.mode === "tide") {
      proof = await this.checkTideApproval(p, req, input);
    }

    return this.d.transaction(() => {
      req.approve(me, proof, now);
      if (req.mode === "tide") req.setTideRequest(input.request!, input.baseVersion ?? -1, now);
      this.d.requests.save(req);
      this.d.audit.append({ at: now, event: "signing.approved", actor: actorOf(p), documentId: req.documentId,
        contentHash: req.contentHash, details: { requestId: req.id, countedAs: req.approvals.at(-1)?.countedAs, quorumMet: req.isQuorumMet(), dokenVerified: proof.dokenVerified ?? null } });
      if (req.mode === "unsigned-dev" && req.status === "quorum_met") this.completeDev(p, req, now);
      return req;
    });
  }

  /** The returned request must be the stored one plus exactly one approval: the caller's. */
  private async checkTideApproval(p: Principal, req: SigningRequest, input: ApproveInput): Promise<ApprovalProof> {
    if (!req.tideRequest) throw new DomainError("NOT_INITIALIZED", "Open the request with Tide first", 409);
    if (!input.request) throw new DomainError("APPROVAL_REQUIRED", "Approve in the Tide window first", 400);
    if (input.baseVersion !== req.tideRequestVersion) throw new DomainError("STALE_REQUEST", "Someone else approved first. Reload and approve again.");
    const before = inspect(fromBase64(req.tideRequest));
    const after = inspect(decodeB64(input.request, "request"));
    const problem = checkRequestShape(after, { unsignedPolicy: fromBase64(req.statement), nowSeconds: nowSeconds(this.d) });
    if (problem) throw new DomainError("INVALID_TIDE_REQUEST", problem, 422);
    if (after.approvals.length !== before.approvals.length + 1 || !before.dokens.every((dk, i) => after.dokens[i] === dk)) {
      throw new DomainError("INVALID_TIDE_REQUEST", "The request must carry exactly one new approval", 422);
    }
    const added = after.approvals.at(-1)!;
    if (added.vuid !== p.vuid) throw new DomainError("APPROVER_MISMATCH", "The Tide approval is not yours", 403);
    if (added.exp <= nowSeconds(this.d)) throw new DomainError("DOKEN_EXPIRED", "Your Tide session expired. Sign in again and approve.", 409);
    if (added.realmRoles.length > 0 && !added.realmRoles.includes(req.requirement.network.role)) {
      throw new DomainError("DOKEN_MISSING_ROLE", `Your Tide session does not carry ${req.requirement.network.role} yet. Sign out, sign in again, then approve.`, 409);
    }
    return {
      kind: "tide-enclave",
      approvalIndex: after.approvals.length - 1,
      dokenVerified: await verifyDoken(this.d.tide.realmKeys, after.dokens.at(-1)!),
      deviceKey: p.deviceKey ?? undefined,
    };
  }

  private completeDev(p: Principal, req: SigningRequest, now: string) {
    const receipts: SignatureReceipt[] = [{ provider: "dev-unsigned", signature: "", signedAt: now, covers: "nothing: Tide signing was not set up" }];
    req.complete(receipts, now);
    this.d.requests.save(req);
    const doc = this.d.documents.get(req.documentId)!;
    doc.markSigned(receipts, now);
    this.d.documents.save(doc);
    this.d.audit.append({ at: now, event: "document.signed", actor: actorOf(p), documentId: doc.id, contentHash: req.contentHash,
      details: { requestId: req.id, provider: "dev-unsigned" } });
  }
}

export class RejectRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string, reason: string) {
    requireMember(p);
    const req = load(this.d, id);
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      try {
        req.reject(identityOf(p), reason, now);
      } catch (e) {
        logRefusal(this.d, p, req, e);
        throw e;
      }
      this.d.requests.save(req);
      const doc = this.d.documents.get(req.documentId);
      if (doc && doc.status === "pending_approval" && doc.currentRequestId === req.id) {
        doc.returnToDraft(now);
        this.d.documents.save(doc);
      }
      this.d.audit.append({ at: now, event: "signing.rejected", actor: actorOf(p), documentId: req.documentId,
        contentHash: req.contentHash, details: { requestId: req.id, reason: reason.trim() } });
      return req;
    });
  }
}

/**
 * The browser that executed the request hands back the network's signature. Nothing is recorded
 * unless it is the realm's Ed25519 signature over exactly this document's approval statement.
 */
export class RecordSignature {
  constructor(private d: Deps) {}
  async execute(p: Principal, id: string, signatureB64: string) {
    requireMember(p);
    const req = load(this.d, id);
    if (req.mode !== "tide") throw new DomainError("NOT_TIDE_MODE", "This request is not signed by the Tide network", 409);
    if (req.status !== "quorum_met") throw new DomainError("QUORUM_NOT_MET", "Approvals are not complete yet");
    const signature = decodeB64(signatureB64, "signature");
    const statement = parsePolicy(fromBase64(req.statement));
    if (!(await verifyRealmSignature(this.d.tide.realmKeys, signature, statement.dataToVerify))) {
      throw new DomainError("SIGNATURE_INVALID", "That is not the Tide network's signature over this approval statement", 422);
    }
    const now = nowIso(this.d);
    const receipts: SignatureReceipt[] = [{
      provider: "tide", signature: toBase64(signature), signedAt: now, covers: "approval-statement-v1",
      keyId: this.d.tide.realmKeys.find((k) => k.crv === "Ed25519")?.kid,
    }];
    const doc = this.d.documents.get(req.documentId);
    if (!doc) throw notFound("Document");
    if (doc.type === "e_invoice") {
      receipts.push(await this.d.ca.signInvoice({ contentHash: req.contentHash, statement: statement.dataToVerify, tideSignature: signature }));
    }
    return this.d.transaction(() => {
      req.complete(receipts, now);
      doc.markSigned(receipts, now);
      this.d.requests.save(req);
      this.d.documents.save(doc);
      this.d.audit.append({ at: now, event: "document.signed", actor: actorOf(p), documentId: doc.id, contentHash: req.contentHash,
        details: { requestId: req.id, providers: receipts.map((r) => r.provider), signature: receipts[0]!.signature } });
      return { request: req, document: doc };
    });
  }
}

/** Anyone can check a stored receipt against the statement it claims to cover. */
export async function verifyStatementSignature(d: Deps, req: SigningRequest): Promise<boolean> {
  const tide = req.snapshot().receipts.find((r) => r.provider === "tide");
  if (!tide) return false;
  const statement = parsePolicy(fromBase64(req.statement));
  return verifyRealmSignature(d.tide.realmKeys, fromBase64(tide.signature), statement.dataToVerify);
}
