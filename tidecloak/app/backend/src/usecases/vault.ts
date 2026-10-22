import { DomainError, invalid, notFound } from "../domain/errors.js";
import { KeyRequest, REQUEST_LIFETIME_SECONDS, type Operation } from "../domain/keyRequest.js";
import { BOARD_ROLE } from "../domain/tier.js";
import { KEY_KINDS, LEVEL_LABEL, LEVELS, quorumFor, VaultKey, type KeyInput } from "../domain/vaultKey.js";
import { fromBase64, toBase64 } from "../lib/encoding.js";
import {
  checkVaultDraft, inspectRequest, readDraftEntry, RequestFormatError, singleApprovalOn, type InspectedRequest, type VaultRequestName,
} from "../tide/requestInspector.js";
import { draftMatchesField, parseSealedField, SealedFieldError } from "../tide/sealedField.js";
import { verifyDoken } from "../tide/signatures.js";
import { VAULT_TAG, vaultPolicyKey } from "../tide/vaultPolicies.js";
import { actorOf, identityOf, nowIso, nowSeconds, requireBoard, type Deps, type Principal } from "./context.js";

const MODEL: Record<Operation, VaultRequestName> = { seal: "PolicyEnabledEncryption", release: "PolicyEnabledDecryption" };

function decodeB64(s: unknown, what: string): Uint8Array {
  try {
    return fromBase64(String(s ?? ""));
  } catch {
    throw new DomainError("INVALID_ENCODING", `${what} must be base64`, 400);
  }
}

function inspect(bytes: Uint8Array): InspectedRequest {
  try {
    return inspectRequest(bytes);
  } catch (e) {
    throw new DomainError("INVALID_TIDE_REQUEST", e instanceof RequestFormatError ? e.message : "Not a Tide request", 422);
  }
}

function requireDraft(d: Deps, b64: unknown, op: Operation): InspectedRequest {
  const r = inspect(decodeB64(b64, "request"));
  const problem = checkVaultDraft(r, { name: MODEL[op], tag: VAULT_TAG, nowSeconds: nowSeconds(d) });
  if (problem) throw new DomainError("INVALID_TIDE_REQUEST", problem, 422);
  return r;
}

function vaultPolicy(d: Deps, quorum: number) {
  const stored = d.tidePolicies.get("vault-policy", vaultPolicyKey(quorum));
  if (!stored) {
    throw new DomainError("VAULT_POLICY_MISSING",
      `The Tide network policy for ${quorum} approval(s) is not signed yet. A realm admin must approve it in Tide setup.`);
  }
  return stored;
}

/** Expiry is applied lazily, whenever a request is looked at. A seal that never finished leaves no key behind. */
function expireIfDue(d: Deps, req: KeyRequest): void {
  const now = nowIso(d);
  if (!req.expireIfDue(now)) return;
  d.transaction(() => {
    d.requests.save(req);
    if (req.operation === "seal") {
      const key = d.keys.get(req.keyId);
      if (key?.status === "pending_seal") { key.refuseSeal(); d.keys.save(key); }
    }
    d.audit.append({ at: now, event: "request.expired", actor: { id: "system", name: "SignGuard" }, keyId: req.keyId, requestId: req.id, details: { operation: req.operation } });
  });
}

function load(d: Deps, id: string): KeyRequest {
  const req = d.requests.get(id);
  if (!req) throw notFound("Request");
  expireIfDue(d, req);
  return req;
}

/** Refused attempts are evidence too: someone tried to approve their own request, or without a board seat. */
function logRefusal(d: Deps, p: Principal, req: KeyRequest, e: unknown) {
  if (e instanceof DomainError && ["REQUESTER_APPROVES_AT_FINISH", "NOT_ON_BOARD", "APPROVER_MISMATCH", "NOT_REQUESTER"].includes(e.code)) {
    d.audit.append({ at: nowIso(d), event: "request.denied_attempt", actor: actorOf(p), keyId: req.keyId, requestId: req.id, details: { code: e.code } });
  }
}

/**
 * The bytes a person hands back from Tide's approval window must be the stored request plus exactly
 * one approval, and that approval must be theirs, unexpired, and carry the board role the network counts.
 */
async function checkOwnApproval(d: Deps, p: Principal, req: KeyRequest, b64: unknown) {
  const base = inspect(fromBase64(req.tideRequest));
  const after = inspect(decodeB64(b64, "request"));
  const single = singleApprovalOn(base, after);
  if (typeof single === "string") throw new DomainError("INVALID_TIDE_REQUEST", single, 422);
  if (single.claims.vuid !== p.vuid) throw new DomainError("APPROVER_MISMATCH", "The Tide approval is not yours", 403);
  if (single.claims.exp <= nowSeconds(d)) throw new DomainError("DOKEN_EXPIRED", "Your Tide session expired. Sign in again and approve.", 409);
  if (single.claims.realmRoles.length > 0 && !single.claims.realmRoles.includes(BOARD_ROLE)) {
    throw new DomainError("DOKEN_MISSING_ROLE", `Your Tide session does not carry ${BOARD_ROLE}. Sign out and in again, then approve.`, 409);
  }
  return { ...single, dokenVerified: await verifyDoken(d.tide.realmKeys, single.doken) };
}

/** What the screens need to offer the right levels and key types. */
export function vaultCatalog(d: Deps) {
  return {
    boardSize: d.settings.boardSize,
    kinds: KEY_KINDS,
    levels: LEVELS.map((level) => ({ level, label: LEVEL_LABEL[level], quorum: quorumFor(level, d.settings.boardSize) })),
    tag: VAULT_TAG,
  };
}

export interface RegisterInput extends KeyInput {
  /** The encryption draft from the registrar's browser (doDraftEncryption): ciphertext only, never the secret. */
  request: unknown;
}

/**
 * A board member puts a key in the vault. Their browser already encrypted it to the Tide network's
 * key; the network signs that ciphertext (making it usable) only once the quorum approves.
 */
export class RegisterKey {
  constructor(private d: Deps) {}
  execute(p: Principal, input: RegisterInput) {
    requireBoard(p);
    const now = nowIso(this.d);
    const requestId = this.d.ids.id("req");
    const key = VaultKey.register(this.d.ids.id("key"), requestId, input, this.d.settings.boardSize, actorOf(p), now);
    vaultPolicy(this.d, key.quorum);
    const draft = requireDraft(this.d, input.request, "seal");
    return this.d.transaction(() => {
      const req = KeyRequest.open({
        id: requestId, keyId: key.id, keyName: key.name, keyLevel: key.level, operation: "seal", quorum: key.quorum,
        requester: { memberId: p.id, vuid: p.vuid, name: actorOf(p).name },
        reason: key.snapshot().description || `Put ${key.name} in the vault`,
        tideRequest: String(input.request), createdAt: now,
        expiresAt: new Date(Math.min(this.d.clock.now().getTime() + REQUEST_LIFETIME_SECONDS.seal * 1000, draft.expiry * 1000)).toISOString(),
      });
      this.d.keys.save(key);
      this.d.requests.save(req);
      this.d.audit.append({ at: now, event: "key.registered", actor: actorOf(p), keyId: key.id, requestId: req.id,
        details: { name: key.name, kind: key.snapshot().kind, level: key.level, quorum: key.quorum } });
      return { key, request: req };
    });
  }
}

export class ListKeys {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    requireBoard(p);
    return this.d.keys.list();
  }
}

export class ViewKey {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    requireBoard(p);
    const key = this.d.keys.get(id);
    if (!key) throw notFound("Key");
    const requests = this.d.requests.list({ keyId: id });
    for (const r of requests) expireIfDue(this.d, r);
    return { key: this.d.keys.get(id)!, requests: this.d.requests.list({ keyId: id }) };
  }
}

/**
 * A board member asks for a key. Their browser drafted the decryption of this key's ciphertext; the
 * server checks the draft really is for this key, so approvers approve exactly what they are shown.
 */
export class RequestRelease {
  constructor(private d: Deps) {}
  execute(p: Principal, keyId: string, input: { reason?: unknown; request?: unknown }) {
    requireBoard(p);
    const key = this.d.keys.get(keyId);
    if (!key) throw notFound("Key");
    if (key.status !== "active" || !key.ciphertext) throw new DomainError("NOT_ACTIVE", "This key is not in the vault");
    const reason = String(input.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 500) throw invalid("Say why you need this key (3 to 500 characters)", "REASON_REQUIRED");
    const open = this.d.requests.list({ keyId, status: ["collecting", "ready"] })
      .filter((r) => { expireIfDue(this.d, r); return r.isOpen() && r.operation === "release" && r.isRequester({ memberId: p.id, vuid: p.vuid }); });
    if (open.length > 0) throw new DomainError("OPEN_REQUEST_EXISTS", "You already have an open request for this key");

    const draft = requireDraft(this.d, input.request, "release");
    let field;
    try { field = parseSealedField(fromBase64(key.ciphertext)); } catch (e) {
      throw new DomainError("CIPHERTEXT_UNREADABLE", e instanceof SealedFieldError ? e.message : "Stored ciphertext is unreadable", 409);
    }
    if (!draftMatchesField(readDraftEntry("PolicyEnabledDecryption", draft.draft), field, { checkSignature: true })) {
      throw new DomainError("INVALID_TIDE_REQUEST", "This decryption request is for a different key", 422);
    }
    vaultPolicy(this.d, key.quorum);

    const now = nowIso(this.d);
    return this.d.transaction(() => {
      const req = KeyRequest.open({
        id: this.d.ids.id("req"), keyId: key.id, keyName: key.name, keyLevel: key.level, operation: "release", quorum: key.quorum,
        requester: { memberId: p.id, vuid: p.vuid, name: actorOf(p).name }, reason, tideRequest: String(input.request), createdAt: now,
        expiresAt: new Date(Math.min(this.d.clock.now().getTime() + REQUEST_LIFETIME_SECONDS.release * 1000, draft.expiry * 1000)).toISOString(),
      });
      this.d.requests.save(req);
      this.d.audit.append({ at: now, event: "release.requested", actor: actorOf(p), keyId: key.id, requestId: req.id,
        details: { name: key.name, level: key.level, quorum: key.quorum, reason } });
      return req;
    });
  }
}

export class Inbox {
  constructor(private d: Deps) {}
  execute(p: Principal) {
    requireBoard(p);
    const open = this.d.requests.list({ status: ["collecting", "ready"] }).filter((r) => { expireIfDue(this.d, r); return r.isOpen(); });
    const me = identityOf(p);
    return {
      waitingForMe: open.filter((r) => {
        try { r.checkCanApprove(me, nowIso(this.d)); return true; } catch { return false; }
      }),
      readyToFinish: open.filter((r) => r.status === "ready" && r.isRequester(me)),
      mine: open.filter((r) => r.isRequester(me)),
      recent: this.d.requests.list({ status: ["completed", "rejected", "cancelled", "expired"] }).slice(0, 8),
    };
  }
}

export class GetRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    requireBoard(p);
    const req = load(this.d, id);
    return { request: req, key: this.d.keys.get(req.keyId) };
  }
}

export class ApproveRequest {
  constructor(private d: Deps) {}
  async execute(p: Principal, id: string, input: { request?: unknown }) {
    const req = load(this.d, id);
    const now = nowIso(this.d);
    try {
      req.checkCanApprove(identityOf(p), now);
    } catch (e) {
      logRefusal(this.d, p, req, e);
      throw e;
    }
    let approval;
    try {
      approval = await checkOwnApproval(this.d, p, req, input.request);
    } catch (e) {
      logRefusal(this.d, p, req, e);
      throw e;
    }
    return this.d.transaction(() => {
      req.approve(identityOf(p), {
        doken: approval.doken, signature: toBase64(approval.signature), dokenVerified: approval.dokenVerified, deviceKey: p.deviceKey,
      }, now);
      this.d.requests.save(req);
      this.d.audit.append({ at: now, event: "request.approved", actor: actorOf(p), keyId: req.keyId, requestId: req.id,
        details: { operation: req.operation, approvals: req.approvals.length, needed: req.othersNeeded(), ready: req.status === "ready", dokenVerified: approval.dokenVerified } });
      return req;
    });
  }
}

export class RejectRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string, reason: string) {
    const req = load(this.d, id);
    const now = nowIso(this.d);
    return this.d.transaction(() => {
      req.reject(identityOf(p), reason, now);
      this.d.requests.save(req);
      if (req.operation === "seal") {
        const key = this.d.keys.get(req.keyId);
        if (key?.status === "pending_seal") { key.refuseSeal(); this.d.keys.save(key); }
      }
      this.d.audit.append({ at: now, event: "request.rejected", actor: actorOf(p), keyId: req.keyId, requestId: req.id,
        details: { operation: req.operation, reason: reason.trim() } });
      return req;
    });
  }
}

export class CancelRequest {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    const req = load(this.d, id);
    const now = nowIso(this.d);
    return this.d.transaction(() => {
      req.cancel({ memberId: p.id, vuid: p.vuid }, now);
      this.d.requests.save(req);
      if (req.operation === "seal") {
        const key = this.d.keys.get(req.keyId);
        if (key?.status === "pending_seal") { key.refuseSeal(); this.d.keys.save(key); }
      }
      this.d.audit.append({ at: now, event: "request.cancelled", actor: actorOf(p), keyId: req.keyId, requestId: req.id, details: { operation: req.operation } });
      return req;
    });
  }
}

/**
 * Everything the requester's browser needs to finish: the other members' approvals and the network
 * policy. Handed out only to the requester and only once the approvals are complete, so nobody else
 * ever holds a request the network would accept. This is the point where the board's approvals
 * leave the server, so it is logged.
 */
export class FinishKit {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    requireBoard(p);
    const req = load(this.d, id);
    try {
      req.checkCanFinish({ memberId: p.id, vuid: p.vuid }, nowIso(this.d));
    } catch (e) {
      logRefusal(this.d, p, req, e);
      throw e;
    }
    const policy = vaultPolicy(this.d, req.quorum);
    this.d.audit.append({ at: nowIso(this.d), event: "request.finish_started", actor: actorOf(p), keyId: req.keyId, requestId: req.id,
      details: { operation: req.operation, approvals: req.approvals.map((a) => a.name) } });
    return {
      policy: policy.signed,
      approvals: req.approvals.map((a) => ({ doken: a.doken, signature: a.signature, name: a.name })),
    };
  }
}

export interface FinishInput {
  /** The stored request plus the requester's own approval, from Tide's window. */
  request?: unknown;
  /** Seal only: the network-signed ciphertext returned by commitEncryption. */
  ciphertext?: unknown;
}

export class FinishRequest {
  constructor(private d: Deps) {}
  async execute(p: Principal, id: string, input: FinishInput) {
    requireBoard(p);
    const req = load(this.d, id);
    const now = nowIso(this.d);
    req.checkCanFinish({ memberId: p.id, vuid: p.vuid }, now);
    const own = await checkOwnApproval(this.d, p, req, input.request);
    const key = this.d.keys.get(req.keyId);
    if (!key) throw notFound("Key");

    let ciphertext: string | null = null;
    if (req.operation === "seal") {
      const bytes = decodeB64(input.ciphertext, "ciphertext");
      if (bytes.length > 64 * 1024) throw invalid("Ciphertext is too large", "INVALID_CIPHERTEXT");
      let field;
      try { field = parseSealedField(bytes); } catch (e) {
        throw new DomainError("INVALID_CIPHERTEXT", e instanceof SealedFieldError ? e.message : "Not a Tide ciphertext", 422);
      }
      if (field.signature.length === 0) throw new DomainError("INVALID_CIPHERTEXT", "The ciphertext carries no network signature", 422);
      const entry = readDraftEntry("PolicyEnabledEncryption", inspect(fromBase64(req.tideRequest)).draft);
      if (!draftMatchesField(entry, field, { checkSignature: false })) {
        throw new DomainError("INVALID_CIPHERTEXT", "This ciphertext is not the value the board approved", 422);
      }
      ciphertext = toBase64(bytes);
    }

    return this.d.transaction(() => {
      req.finish({ memberId: p.id, vuid: p.vuid }, own.dokenVerified, now);
      this.d.requests.save(req);
      if (ciphertext) {
        key.seal(ciphertext, now);
        this.d.audit.append({ at: now, event: "key.sealed", actor: actorOf(p), keyId: key.id, requestId: req.id,
          details: { name: key.name, level: key.level, quorum: key.quorum, approvedBy: req.approvals.map((a) => a.name) } });
      } else {
        key.recordRelease(actorOf(p), now);
        this.d.audit.append({ at: now, event: "release.completed", actor: actorOf(p), keyId: key.id, requestId: req.id,
          details: { name: key.name, level: key.level, quorum: key.quorum, approvedBy: req.approvals.map((a) => a.name) } });
      }
      this.d.keys.save(key);
      return { request: req, key };
    });
  }
}
