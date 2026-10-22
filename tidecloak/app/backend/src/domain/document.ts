import { canonicalJson, sha256Hex } from "../lib/encoding.js";
import { ContentHash } from "./contentHash.js";
import { DomainError, invalid } from "./errors.js";
import { Money } from "./money.js";

export const DOCUMENT_TYPES = ["payment_voucher", "e_invoice"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentStatus = "draft" | "pending_approval" | "signed";

/**
 * How the sensitive fields are stored.
 *  - "tide-relationship-v1": ciphertext from Tide's RelationshipAttestation:1 contract; the server
 *    never sees the plaintext.
 *  - "plaintext-dev": only when SIGNGUARD_ALLOW_PLAINTEXT_DEV=true, for local testing without the
 *    encryption policy. Every screen labels such a document as unprotected.
 */
export type Sealing = "tide-relationship-v1" | "plaintext-dev";

export const SEALED_FIELDS = ["counterparty", "bankAccount", "description"] as const;
export type SealedField = (typeof SEALED_FIELDS)[number];
export type SealedValues = Record<SealedField, string>;

export interface Actor {
  id: string;
  name: string;
}

export interface SignatureReceipt {
  /** "dev-unsigned" exists only when SIGNGUARD_ALLOW_UNSIGNED_DEV=true and is shown as unprotected. */
  provider: "tide" | "mock-ca" | "dev-unsigned";
  /** base64 */
  signature: string;
  signedAt: string;
  /** What the signature covers, so a verifier can rebuild the exact bytes. */
  covers: string;
  keyId?: string;
}

export interface DocumentProps {
  id: string;
  number: string;
  type: DocumentType;
  title: string;
  amount: Money;
  resourceGroupId: string;
  sealing: Sealing;
  sealed: SealedValues;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  editVersion: number;
  status: DocumentStatus;
  contentHash: ContentHash | null;
  submittedAt: string | null;
  signedAt: string | null;
  currentRequestId: string | null;
  receipts: SignatureReceipt[];
}

export interface DraftInput {
  type: DocumentType;
  title: string;
  amount: Money;
  resourceGroupId: string;
  sealing: Sealing;
  sealed: SealedValues;
}

const MAX_SEALED_LENGTH = 16_384;

function checkDraft(input: Pick<DraftInput, "title" | "sealed" | "sealing">) {
  const title = input.title.trim();
  if (!title || title.length > 200) throw invalid("Title must be 1 to 200 characters", "INVALID_TITLE");
  for (const field of SEALED_FIELDS) {
    const value = input.sealed[field];
    if (typeof value !== "string") throw invalid(`${field} is required`, "INVALID_FIELD");
    if (value.length > MAX_SEALED_LENGTH) throw invalid(`${field} is too long`, "INVALID_FIELD");
  }
  if (!input.sealed.counterparty) throw invalid("Counterparty is required", "INVALID_FIELD");
}

export class Document {
  private constructor(private props: DocumentProps) {}

  static createDraft(id: string, number: string, input: DraftInput, by: Actor, now: string): Document {
    checkDraft(input);
    return new Document({
      id,
      number,
      type: input.type,
      title: input.title.trim(),
      amount: input.amount,
      resourceGroupId: input.resourceGroupId,
      sealing: input.sealing,
      sealed: { ...input.sealed },
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      editVersion: 1,
      status: "draft",
      contentHash: null,
      submittedAt: null,
      signedAt: null,
      currentRequestId: null,
      receipts: [],
    });
  }

  static restore(props: DocumentProps): Document {
    return new Document({ ...props });
  }

  get id() { return this.props.id; }
  get number() { return this.props.number; }
  get type() { return this.props.type; }
  get title() { return this.props.title; }
  get amount() { return this.props.amount; }
  get resourceGroupId() { return this.props.resourceGroupId; }
  get status() { return this.props.status; }
  get contentHash() { return this.props.contentHash; }
  get createdBy() { return this.props.createdBy; }
  get currentRequestId() { return this.props.currentRequestId; }
  get sealing() { return this.props.sealing; }
  get editVersion() { return this.props.editVersion; }

  /** Edits are allowed only on a Draft. Use `returnToDraft` first for a pending document. */
  edit(patch: Partial<Omit<DraftInput, "sealing">> & { sealing?: Sealing }, now: string): void {
    if (this.props.status !== "draft") {
      throw new DomainError("NOT_DRAFT", "Only a draft can be edited");
    }
    const next = {
      title: patch.title ?? this.props.title,
      sealed: patch.sealed ? { ...patch.sealed } : this.props.sealed,
      sealing: patch.sealing ?? this.props.sealing,
    };
    checkDraft(next);
    this.props = {
      ...this.props,
      ...next,
      title: next.title.trim(),
      type: patch.type ?? this.props.type,
      amount: patch.amount ?? this.props.amount,
      resourceGroupId: patch.resourceGroupId ?? this.props.resourceGroupId,
      editVersion: this.props.editVersion + 1,
      updatedAt: now,
    };
  }

  /** The exact content the hash covers. Sealed fields are hashed as stored (ciphertext). */
  canonicalContent(): Record<string, unknown> {
    const p = this.props;
    return {
      id: p.id,
      number: p.number,
      type: p.type,
      title: p.title,
      amountDong: p.amount.toString(),
      currency: "VND",
      resourceGroupId: p.resourceGroupId,
      sealing: p.sealing,
      sealed: p.sealed,
      createdById: p.createdBy.id,
      editVersion: p.editVersion,
    };
  }

  computeHash(): ContentHash {
    return ContentHash.of(sha256Hex(canonicalJson(this.canonicalContent())));
  }

  /** Freezes the content hash. From here until it returns to Draft, the content cannot change. */
  submit(requestId: string, now: string): ContentHash {
    if (this.props.status !== "draft") throw new DomainError("NOT_DRAFT", "Only a draft can be submitted");
    const hash = this.computeHash();
    this.props = { ...this.props, status: "pending_approval", contentHash: hash, submittedAt: now, currentRequestId: requestId, updatedAt: now };
    return hash;
  }

  /** A reject, a withdrawal or an expiry sends the document back to Draft. */
  returnToDraft(now: string): void {
    if (this.props.status !== "pending_approval") throw new DomainError("NOT_PENDING", "Document is not pending approval");
    this.props = { ...this.props, status: "draft", contentHash: null, submittedAt: null, currentRequestId: null, updatedAt: now };
  }

  markSigned(receipts: SignatureReceipt[], now: string): void {
    if (this.props.status !== "pending_approval") throw new DomainError("NOT_PENDING", "Document is not pending approval");
    if (!this.props.contentHash || !this.props.contentHash.equals(this.computeHash())) {
      // Defence in depth: the stored content no longer matches the hash that was approved.
      throw new DomainError("HASH_MISMATCH", "Document content changed after submission", 409);
    }
    if (receipts.length === 0) throw new DomainError("NO_RECEIPT", "A signed document needs a signature receipt");
    this.props = { ...this.props, status: "signed", signedAt: now, receipts: [...this.props.receipts, ...receipts], updatedAt: now };
  }

  snapshot(): DocumentProps {
    return { ...this.props, sealed: { ...this.props.sealed }, receipts: [...this.props.receipts] };
  }
}
