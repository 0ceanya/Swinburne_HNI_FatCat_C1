import { canonicalJson, sha256Hex } from "../lib/encoding.js";
import type { Actor } from "./vaultKey.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditEvent =
  | "tide.vault_policy_signed"
  | "key.registered"
  | "key.sealed"
  | "key.seal_refused"
  | "release.requested"
  | "request.approved"
  | "request.rejected"
  | "request.cancelled"
  | "request.expired"
  | "request.denied_attempt"
  | "request.finish_started"
  | "release.completed";

export interface AuditEntryProps {
  seq: number;
  at: string;
  event: AuditEvent;
  actor: Actor;
  keyId: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** Append-only. Each entry hashes the one before it, so editing any entry breaks the chain after it. */
export class AuditEntry {
  private constructor(readonly props: AuditEntryProps) {}

  static hashOf(p: Omit<AuditEntryProps, "hash">): string {
    return sha256Hex(canonicalJson({
      seq: p.seq, at: p.at, event: p.event, actor: p.actor, keyId: p.keyId,
      requestId: p.requestId, details: p.details, prevHash: p.prevHash,
    }));
  }

  static next(prev: AuditEntry | null, e: Omit<AuditEntryProps, "seq" | "prevHash" | "hash">): AuditEntry {
    const base = { ...e, seq: prev ? prev.props.seq + 1 : 1, prevHash: prev ? prev.props.hash : GENESIS_HASH };
    return new AuditEntry({ ...base, hash: AuditEntry.hashOf(base) });
  }

  static restore(p: AuditEntryProps): AuditEntry {
    return new AuditEntry({ ...p });
  }

  /** True when this entry's hash is correct and it follows `prev` (null for the first entry). */
  chainsTo(prev: AuditEntry | null): boolean {
    const expectedPrev = prev ? prev.props.hash : GENESIS_HASH;
    const expectedSeq = prev ? prev.props.seq + 1 : 1;
    const { hash, ...rest } = this.props;
    return this.props.prevHash === expectedPrev && this.props.seq === expectedSeq && AuditEntry.hashOf(rest) === hash;
  }
}

export interface ChainCheck {
  ok: boolean;
  length: number;
  /** First entry that fails, if any. */
  brokenAtSeq: number | null;
}

/** Recompute the chain from the stored fields and report the first entry that does not follow. */
export function checkChain(entries: AuditEntry[]): ChainCheck {
  let prevHash = GENESIS_HASH;
  let brokenAtSeq: number | null = null;
  entries.forEach((entry, i) => {
    const { hash: _stored, ...rest } = entry.props;
    const real = AuditEntry.hashOf({ ...rest, prevHash });
    if (brokenAtSeq === null && (!entry.chainsTo(i === 0 ? null : entries[i - 1]!) || entry.props.prevHash !== prevHash)) {
      brokenAtSeq = entry.props.seq;
    }
    prevHash = real;
  });
  return { ok: brokenAtSeq === null, length: entries.length, brokenAtSeq };
}
