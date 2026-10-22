import { DomainError, forbidden, invalid, notFound } from "../domain/errors.js";
import { Document, DOCUMENT_TYPES, SEALED_FIELDS, type DocumentType, type Sealing, type SealedValues } from "../domain/document.js";
import { Member } from "../domain/member.js";
import { Money } from "../domain/money.js";
import { REQUEST_LIFETIME_SECONDS, SigningRequest } from "../domain/signingRequest.js";
import { toBase64 } from "../lib/encoding.js";
import { statementFields, unsignedPolicy } from "../tide/signguardPolicies.js";
import { actorOf, nowIso, requireMember, requireTier, type Deps, type Principal } from "./context.js";
import { ruleKey } from "./policy.js";

export interface DraftRequest {
  type: string;
  title: string;
  amountDong: string;
  resourceGroupId: string;
  sealing: string;
  sealed: Record<string, string>;
}


function memberRecord(d: Deps, p: Principal): Member {
  return d.members.get(p.id) ?? Member.seen({
    id: p.id, vuid: p.vuid, username: p.username, firstName: p.firstName, lastName: p.lastName,
    tideUserKey: p.tideUserKey, tiers: p.tiers, lastSeenAt: nowIso(d),
  }, null);
}

function parseDraft(d: Deps, input: Partial<DraftRequest>) {
  if (input.type !== undefined && !DOCUMENT_TYPES.includes(input.type as DocumentType)) throw invalid("Unknown document type", "INVALID_TYPE");
  if (input.resourceGroupId !== undefined && !d.members.groups().some((g) => g.id === input.resourceGroupId)) {
    throw invalid("Unknown resource group", "INVALID_GROUP");
  }
  let sealing: Sealing | undefined;
  if (input.sealing !== undefined) {
    if (input.sealing === "tide-relationship-v1") {
      if (!d.tidePolicies.get("sealed-fields", "sealed-fields")) {
        throw new DomainError("SEALING_NOT_SET_UP", "Field encryption is not set up yet. A realm admin must approve the sealed-fields policy in Tide setup.");
      }
      sealing = "tide-relationship-v1";
    } else if (input.sealing === "plaintext-dev") {
      if (!d.settings.allowPlaintextDev) throw forbidden("Unencrypted fields are disabled on this server", "PLAINTEXT_DISABLED");
      sealing = "plaintext-dev";
    } else throw invalid("Unknown sealing", "INVALID_SEALING");
  }
  let sealed: SealedValues | undefined;
  if (input.sealed !== undefined) {
    sealed = {} as SealedValues;
    for (const f of SEALED_FIELDS) sealed[f] = String(input.sealed[f] ?? "");
  }
  return {
    type: input.type as DocumentType | undefined,
    title: input.title,
    amount: input.amountDong !== undefined ? Money.ofDong(input.amountDong) : undefined,
    resourceGroupId: input.resourceGroupId,
    sealing,
    sealed,
  };
}

function requireDrafterInGroup(d: Deps, p: Principal, groupId: string) {
  requireTier(p, "drafter");
  if (!memberRecord(d, p).belongsTo(groupId)) throw forbidden("You can only draft documents in your own resource groups", "NOT_IN_GROUP");
}

export class CreateDraft {
  constructor(private d: Deps) {}
  execute(p: Principal, input: DraftRequest): Document {
    const parsed = parseDraft(this.d, input);
    if (!parsed.type || parsed.title === undefined || !parsed.amount || !parsed.resourceGroupId || !parsed.sealing || !parsed.sealed) {
      throw invalid("type, title, amountDong, resourceGroupId, sealing and sealed are required", "INVALID_DRAFT");
    }
    requireDrafterInGroup(this.d, p, parsed.resourceGroupId);
    return this.d.transaction(() => {
      const now = nowIso(this.d);
      const doc = Document.createDraft(this.d.ids.id("doc"), this.d.documents.nextNumber(parsed.type!), {
        type: parsed.type!, title: parsed.title!, amount: parsed.amount!, resourceGroupId: parsed.resourceGroupId!,
        sealing: parsed.sealing!, sealed: parsed.sealed!,
      }, actorOf(p), now);
      this.d.documents.save(doc);
      this.d.audit.append({ at: now, event: "document.created", actor: actorOf(p), documentId: doc.id, contentHash: null,
        details: { number: doc.number, type: doc.type, amountDong: doc.amount.toString(), sealing: doc.sealing } });
      return doc;
    });
  }
}

/** Withdraw cancels the open request and returns the document to Draft. */
function withdraw(d: Deps, p: Principal, doc: Document, reason: string) {
  const now = nowIso(d);
  const req = doc.currentRequestId ? d.requests.get(doc.currentRequestId) : null;
  if (req?.isOpen()) {
    req.cancel(reason, now);
    d.requests.save(req);
  }
  doc.returnToDraft(now);
  d.audit.append({ at: now, event: "document.withdrawn", actor: actorOf(p), documentId: doc.id, contentHash: req?.contentHash ?? null,
    details: { requestId: req?.id ?? null, reason } });
}

export class EditDraft {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string, patch: Partial<DraftRequest>): Document {
    const doc = this.d.documents.get(id);
    if (!doc) throw notFound("Document");
    requireDrafterInGroup(this.d, p, doc.resourceGroupId);
    const parsed = parseDraft(this.d, patch);
    if (parsed.resourceGroupId) requireDrafterInGroup(this.d, p, parsed.resourceGroupId);
    if (doc.status === "signed") throw new DomainError("SIGNED", "A signed document cannot be edited");
    return this.d.transaction(() => {
      // "Any edit returns it to Draft and cancels the open SigningRequest."
      if (doc.status === "pending_approval") withdraw(this.d, p, doc, "Edited after submission");
      const now = nowIso(this.d);
      doc.edit({ type: parsed.type, title: parsed.title, amount: parsed.amount, resourceGroupId: parsed.resourceGroupId, sealed: parsed.sealed, sealing: parsed.sealing }, now);
      this.d.documents.save(doc);
      this.d.audit.append({ at: now, event: "document.edited", actor: actorOf(p), documentId: doc.id, contentHash: null,
        details: { editVersion: doc.editVersion, amountDong: doc.amount.toString() } });
      return doc;
    });
  }
}

export class WithdrawDocument {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string): Document {
    const doc = this.d.documents.get(id);
    if (!doc) throw notFound("Document");
    requireDrafterInGroup(this.d, p, doc.resourceGroupId);
    if (doc.status !== "pending_approval") throw new DomainError("NOT_PENDING", "Only a pending document can be withdrawn");
    return this.d.transaction(() => {
      withdraw(this.d, p, doc, "Withdrawn by drafter");
      this.d.documents.save(doc);
      return doc;
    });
  }
}

export class ListDocuments {
  constructor(private d: Deps) {}
  execute(p: Principal, filter: { status?: string; type?: string; resourceGroupId?: string }) {
    requireMember(p);
    return this.d.documents.list(filter);
  }
}

export class ViewDocument {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    requireMember(p);
    const doc = this.d.documents.get(id);
    if (!doc) throw notFound("Document");
    const requests = this.d.requests.list({ documentId: id });
    // Expiry is applied lazily, when someone looks.
    for (const r of requests) {
      if (r.expireIfDue(nowIso(this.d))) expireRequest(this.d, r);
    }
    return { document: this.d.documents.get(id)!, requests: this.d.requests.list({ documentId: id }) };
  }
}

export function expireRequest(d: Deps, r: SigningRequest) {
  d.transaction(() => {
    const now = nowIso(d);
    d.requests.save(r);
    const doc = d.documents.get(r.documentId);
    if (doc && doc.status === "pending_approval" && doc.currentRequestId === r.id) {
      doc.returnToDraft(now);
      d.documents.save(doc);
    }
    d.audit.append({ at: now, event: "signing.expired", actor: { id: "system", name: "SignGuard" }, documentId: r.documentId,
      contentHash: r.contentHash, details: { requestId: r.id } });
  });
}

export class SubmitForSigning {
  constructor(private d: Deps) {}
  execute(p: Principal, id: string) {
    const doc = this.d.documents.get(id);
    if (!doc) throw notFound("Document");
    requireDrafterInGroup(this.d, p, doc.resourceGroupId);
    if (doc.status !== "draft") throw new DomainError("NOT_DRAFT", "Only a draft can be submitted");
    const policy = this.d.policies.active();
    if (!policy) throw new DomainError("NO_POLICY", "No approval policy is active");
    const requirement = policy.requirementFor(doc.type, doc.amount);

    const rule = this.d.tidePolicies.get("signing-rule", ruleKey(requirement.policyVersion, requirement.ruleId));
    const mode = rule ? "tide" : this.d.settings.allowUnsignedDev ? "unsigned-dev" : null;
    if (!mode) {
      throw new DomainError("TIDE_SIGNING_NOT_SET_UP",
        `The Tide network rule for "${requirement.label}" is not signed yet. A realm admin must approve it in Tide setup.`);
    }

    return this.d.transaction(() => {
      const now = nowIso(this.d);
      const requestId = this.d.ids.id("req");
      const hash = doc.submit(requestId, now);
      const anchor = this.d.audit.append({ at: now, event: "document.submitted", actor: actorOf(p), documentId: doc.id,
        contentHash: hash.hex, details: { requestId, ruleId: requirement.ruleId, policyVersion: requirement.policyVersion, mode } });
      const statement = unsignedPolicy(statementFields({
        vendorId: this.d.tide.vendorId, clientId: this.d.tide.clientId, org: this.d.settings.org.taxCode,
        requestId, docId: doc.id, docNumber: doc.number, docType: doc.type, amountDong: doc.amount.toString(),
        contentHash: hash.hex, band: requirement.ruleId, policyVersion: requirement.policyVersion,
        initiatorVuid: p.vuid, auditSeq: anchor.props.seq, auditHead: anchor.props.hash,
      }));
      const req = SigningRequest.open({
        id: requestId, documentId: doc.id, documentNumber: doc.number, documentType: doc.type,
        amountDong: doc.amount.toString(), contentHash: hash.hex, requirement,
        initiator: { memberId: p.id, vuid: p.vuid, name: actorOf(p).name }, mode,
        createdAt: now, expiresAt: new Date(this.d.clock.now().getTime() + REQUEST_LIFETIME_SECONDS * 1000).toISOString(),
        statement: toBase64(statement), auditAnchor: { seq: anchor.props.seq, hash: anchor.props.hash },
      });
      this.d.documents.save(doc);
      this.d.requests.save(req);
      return { document: doc, request: req, signingRule: rule?.signed ?? null };
    });
  }
}
