import { DomainError, invalid } from "./errors.js";

/**
 * A third-party secret SignGuard keeps locked: a CA signing credential, a cloud root key, an API
 * key. SignGuard never holds it in the clear. The browser encrypts it with Tide under a policy that
 * makes the Tide network refuse to decrypt it until `quorum` board members have approved.
 */

/** 1 = standard … 4 = critical. The level is the number of people who must agree, capped at the board size. */
export const LEVELS = [1, 2, 3, 4] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABEL: Record<Level, string> = { 1: "Standard", 2: "Elevated", 3: "High", 4: "Critical" };

export function isLevel(v: unknown): v is Level {
  return typeof v === "number" && (LEVELS as readonly number[]).includes(v);
}

/** People who must approve (the requester included) to seal or unlock a key of this level. */
export function quorumFor(level: Level, boardSize: number): number {
  if (!Number.isInteger(boardSize) || boardSize < 1) throw new RangeError("board size must be a positive integer");
  return Math.min(level, boardSize);
}

export interface KeyKind {
  id: string;
  label: string;
  /** Level suggested when registering; the registrar can change it and the board approves it. */
  defaultLevel: Level;
  examples: string;
}

export const KEY_KINDS: KeyKind[] = [
  { id: "cloud_root", label: "Cloud root credential", defaultLevel: 4, examples: "AWS root, Google Cloud org admin, Azure global admin" },
  { id: "digital_signature", label: "Digital signature (chữ ký số)", defaultLevel: 3, examples: "Viettel MySign, VNPT SmartCA, FPT-CA: credential and PIN" },
  { id: "banking", label: "Banking credential", defaultLevel: 3, examples: "Corporate e-banking login, payment token, Smart OTP" },
  { id: "api_key", label: "API key", defaultLevel: 2, examples: "Payment gateway, e-invoice provider, SMS gateway" },
  { id: "database", label: "Server / database credential", defaultLevel: 2, examples: "Production database password, SSH key" },
  { id: "other", label: "Other secret", defaultLevel: 1, examples: "Shared account, Wi-Fi, software licence" },
];

export const isKeyKind = (v: unknown): v is string => typeof v === "string" && KEY_KINDS.some((k) => k.id === v);

/**
 * pending_seal: the browser encrypted it; the network signs the ciphertext only once the quorum
 *   approves, so it is not usable yet.
 * active: sealed; unlocking needs the quorum every time.
 * rejected: the board refused to seal it (or the request was cancelled or expired). Nothing is stored.
 */
export type KeyStatus = "pending_seal" | "active" | "rejected";

export interface Actor {
  id: string;
  name: string;
}

export interface VaultKeyProps {
  id: string;
  name: string;
  kind: string;
  provider: string;
  description: string;
  /** Optional non-secret reminder such as "••••4821", chosen by the registrar. */
  hint: string;
  level: Level;
  /** Fixed when sealed: the ciphertext is bound to the network policy for this many approvals. */
  quorum: number;
  status: KeyStatus;
  /** base64 PolicyProtectedSerializedField returned by the network; null until sealed. */
  ciphertext: string | null;
  createdBy: Actor;
  createdAt: string;
  sealedAt: string | null;
  sealRequestId: string;
  releaseCount: number;
  lastReleasedAt: string | null;
  lastReleasedTo: Actor | null;
}

export interface KeyInput {
  name: unknown;
  kind: unknown;
  provider: unknown;
  description: unknown;
  hint: unknown;
  level: unknown;
}

const text = (v: unknown, max: number, what: string, required = false): string => {
  const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
  if (required && !s) throw invalid(`${what} is required`, "INVALID_KEY");
  if (s.length > max) throw invalid(`${what} must be at most ${max} characters`, "INVALID_KEY");
  return s;
};

export class VaultKey {
  private constructor(private props: VaultKeyProps) {}

  static register(id: string, sealRequestId: string, input: KeyInput, boardSize: number, by: Actor, now: string): VaultKey {
    if (!isKeyKind(input.kind)) throw invalid("Unknown key type", "INVALID_KEY");
    if (!isLevel(input.level)) throw invalid("Level must be 1, 2, 3 or 4", "INVALID_KEY");
    return new VaultKey({
      id,
      name: text(input.name, 120, "Name", true),
      kind: input.kind,
      provider: text(input.provider, 80, "Provider"),
      description: text(input.description, 500, "Description"),
      hint: text(input.hint, 40, "Hint"),
      level: input.level,
      quorum: quorumFor(input.level, boardSize),
      status: "pending_seal",
      ciphertext: null,
      createdBy: by,
      createdAt: now,
      sealedAt: null,
      sealRequestId,
      releaseCount: 0,
      lastReleasedAt: null,
      lastReleasedTo: null,
    });
  }

  static restore(props: VaultKeyProps): VaultKey {
    return new VaultKey({ ...props });
  }

  get id() { return this.props.id; }
  get name() { return this.props.name; }
  get level() { return this.props.level; }
  get quorum() { return this.props.quorum; }
  get status() { return this.props.status; }
  get ciphertext() { return this.props.ciphertext; }

  /** The network signed the ciphertext under the quorum policy: the key is now in the vault. */
  seal(ciphertext: string, now: string): void {
    if (this.props.status !== "pending_seal") throw new DomainError("NOT_PENDING", "This key is not waiting to be sealed");
    this.props = { ...this.props, status: "active", ciphertext, sealedAt: now };
  }

  refuseSeal(): void {
    if (this.props.status !== "pending_seal") throw new DomainError("NOT_PENDING", "This key is not waiting to be sealed");
    this.props = { ...this.props, status: "rejected" };
  }

  recordRelease(to: Actor, now: string): void {
    if (this.props.status !== "active") throw new DomainError("NOT_ACTIVE", "This key is not in the vault");
    this.props = { ...this.props, releaseCount: this.props.releaseCount + 1, lastReleasedAt: now, lastReleasedTo: to };
  }

  snapshot(): VaultKeyProps {
    return { ...this.props };
  }
}
