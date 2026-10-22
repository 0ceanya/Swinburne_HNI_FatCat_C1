import { checkChain } from "../domain/auditEntry.js";
import { fromBase64 } from "../lib/encoding.js";
import { parsePolicy } from "../tide/policyBytes.js";
import { verifyRealmSignature } from "../tide/signatures.js";
import { requireTier, type Deps, type Principal } from "./context.js";

export class ListAudit {
  constructor(private d: Deps) {}
  execute(p: Principal, filter: { documentId?: string } = {}) {
    requireTier(p, "director", "owner");
    const all = this.d.audit.all();
    return filter.documentId ? all.filter((e) => e.props.documentId === filter.documentId) : all;
  }
}

export interface AnchorResult {
  requestId: string;
  documentId: string;
  auditSeq: number;
  /** The Tide signature over the statement is valid. */
  signatureValid: boolean;
  /** The audit hash the network signed equals the recomputed hash at that position. */
  matchesLog: boolean;
}

export interface AuditVerification {
  ok: boolean;
  length: number;
  brokenAtSeq: number | null;
  anchors: AnchorResult[];
  checkedAt: string;
}

/**
 * Two layers. The hash chain catches an edit to any entry. The anchors catch the attacker who also
 * rewrites every later hash: each signed document's approval statement carries the audit head at
 * submission, signed by the Tide network, and the server cannot forge that signature.
 */
export class VerifyAuditChain {
  constructor(private d: Deps) {}
  async execute(p: Principal): Promise<AuditVerification> {
    requireTier(p, "director", "owner");
    const entries = this.d.audit.all();
    const chain = checkChain(entries);
    const anchors: AnchorResult[] = [];
    for (const req of this.d.requests.list({ status: ["signed"] })) {
      const tide = req.snapshot().receipts.find((r) => r.provider === "tide");
      if (!tide) continue;
      const statement = parsePolicy(fromBase64(req.statement));
      const signatureValid = await verifyRealmSignature(this.d.tide.realmKeys, fromBase64(tide.signature), statement.dataToVerify);
      const seq = Number(statement.params.auditseq);
      const head = String(statement.params.audithead);
      anchors.push({ requestId: req.id, documentId: req.documentId, auditSeq: seq, signatureValid, matchesLog: chain.recomputed.get(seq) === head });
    }
    return {
      ok: chain.ok && anchors.every((a) => a.signatureValid && a.matchesLog),
      length: chain.length,
      brokenAtSeq: chain.brokenAtSeq,
      anchors,
      checkedAt: this.d.clock.now().toISOString(),
    };
  }
}
