import { checkChain } from "../domain/auditEntry.js";
import { requireBoard, type Deps, type Principal } from "./context.js";

export class ListAudit {
  constructor(private d: Deps) {}
  execute(p: Principal, filter: { keyId?: string } = {}) {
    requireBoard(p);
    const all = this.d.audit.all();
    return filter.keyId ? all.filter((e) => e.props.keyId === filter.keyId) : all;
  }
}

export interface AuditVerification {
  ok: boolean;
  length: number;
  brokenAtSeq: number | null;
  checkedAt: string;
}

/** Every entry hashes the one before it, so an edit to any past entry is caught here. */
export class VerifyAuditChain {
  constructor(private d: Deps) {}
  execute(p: Principal): AuditVerification {
    requireBoard(p);
    const chain = checkChain(this.d.audit.all());
    return { ok: chain.ok, length: chain.length, brokenAtSeq: chain.brokenAtSeq, checkedAt: this.d.clock.now().toISOString() };
  }
}
