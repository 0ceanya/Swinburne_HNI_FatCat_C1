import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApprovalPolicy, type ApprovalPolicyProps } from "../domain/approvalPolicy.js";
import { AuditEntry, type AuditEntryProps } from "../domain/auditEntry.js";
import { ContentHash } from "../domain/contentHash.js";
import { Document, type DocumentProps } from "../domain/document.js";
import { JoinRequest, type JoinRequestProps } from "../domain/joinRequest.js";
import { Member, type MemberProps, type ResourceGroup } from "../domain/member.js";
import { Money } from "../domain/money.js";
import { SigningRequest, type SigningRequestProps } from "../domain/signingRequest.js";
import type { Tier } from "../domain/tier.js";
import type {
  AuditLog, DocumentRepository, JoinRequestRepository, MemberRepository, PolicyRepository, SigningRequestRepository,
  StoredTidePolicy, TidePolicyRepository, TierTargetRepository, UnitOfWork,
} from "../usecases/ports.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
  resource_group TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signing_requests (id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
  status TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies (version INTEGER PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tide_policies (kind TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (kind, key));
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resource_groups (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_requests_doc ON signing_requests(document_id);
CREATE TABLE IF NOT EXISTS join_requests (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tier_targets (user_id TEXT PRIMARY KEY, json TEXT NOT NULL);
`;

// bigint and the value objects do not survive JSON.stringify on their own.
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as Record<string, unknown>) ? BigInt((v as { $big: string }).$big) : v;
const toJson = (v: unknown) => JSON.stringify(v, replacer);
const fromJson = <T>(s: string): T => JSON.parse(s, reviver) as T;

function docToJson(d: Document): string {
  const p = d.snapshot();
  return toJson({ ...p, amount: p.amount.toString(), contentHash: p.contentHash?.hex ?? null });
}

function docFromJson(s: string): Document {
  const raw = fromJson<Omit<DocumentProps, "amount" | "contentHash"> & { amount: string; contentHash: string | null }>(s);
  return Document.restore({ ...raw, amount: Money.ofDong(raw.amount), contentHash: raw.contentHash ? ContentHash.of(raw.contentHash) : null });
}

const TYPE_PREFIX: Record<string, string> = { payment_voucher: "PC", e_invoice: "HD" };

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly documents: DocumentRepository;
  readonly requests: SigningRequestRepository;
  readonly policies: PolicyRepository;
  readonly tidePolicies: TidePolicyRepository;
  readonly audit: AuditLog;
  readonly members: MemberRepository;
  readonly joinRequests: JoinRequestRepository;
  readonly tierTargets: TierTargetRepository;
  readonly transaction: UnitOfWork;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const db = this.db;

    let depth = 0;
    this.transaction = <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    };

    this.documents = {
      get: (id) => {
        const row = db.prepare("SELECT json FROM documents WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? docFromJson(row.json) : null;
      },
      list: (f = {}) => {
        const where: string[] = [];
        const args: string[] = [];
        if (f.status) { where.push("status = ?"); args.push(f.status); }
        if (f.type) { where.push("type = ?"); args.push(f.type); }
        if (f.resourceGroupId) { where.push("resource_group = ?"); args.push(f.resourceGroupId); }
        const sql = `SELECT json FROM documents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC`;
        return (db.prepare(sql).all(...args) as { json: string }[]).map((r) => docFromJson(r.json));
      },
      save: (d) => {
        db.prepare(`INSERT INTO documents (id, type, status, resource_group, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status,
          resource_group = excluded.resource_group, json = excluded.json, updated_at = excluded.updated_at`)
          .run(d.id, d.type, d.status, d.resourceGroupId, docToJson(d), d.snapshot().updatedAt);
      },
      nextNumber: (type) => {
        const name = `doc:${type}`;
        db.prepare("INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1").run(name);
        const { value } = db.prepare("SELECT value FROM counters WHERE name = ?").get(name) as { value: number };
        return `${TYPE_PREFIX[type] ?? "DOC"}-${String(value).padStart(4, "0")}`;
      },
    };

    this.requests = {
      get: (id) => {
        const row = db.prepare("SELECT json FROM signing_requests WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? SigningRequest.restore(fromJson<SigningRequestProps>(row.json)) : null;
      },
      list: (f = {}) => {
        const where: string[] = [];
        const args: string[] = [];
        if (f.documentId) { where.push("document_id = ?"); args.push(f.documentId); }
        if (f.status?.length) { where.push(`status IN (${f.status.map(() => "?").join(",")})`); args.push(...f.status); }
        const sql = `SELECT json FROM signing_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rowid DESC`;
        return (db.prepare(sql).all(...args) as { json: string }[]).map((r) => SigningRequest.restore(fromJson<SigningRequestProps>(r.json)));
      },
      save: (r) => {
        db.prepare(`INSERT INTO signing_requests (id, document_id, status, json) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`)
          .run(r.id, r.documentId, r.status, toJson(r.snapshot()));
      },
    };

    this.policies = {
      active: () => {
        const row = db.prepare("SELECT json FROM policies WHERE status = 'active' ORDER BY version DESC LIMIT 1").get() as { json: string } | undefined;
        return row ? ApprovalPolicy.restore(fromJson<ApprovalPolicyProps>(row.json)) : null;
      },
      get: (version) => {
        const row = db.prepare("SELECT json FROM policies WHERE version = ?").get(version) as { json: string } | undefined;
        return row ? ApprovalPolicy.restore(fromJson<ApprovalPolicyProps>(row.json)) : null;
      },
      list: () => (db.prepare("SELECT json FROM policies ORDER BY version DESC").all() as { json: string }[])
        .map((r) => ApprovalPolicy.restore(fromJson<ApprovalPolicyProps>(r.json))),
      save: (p) => {
        db.prepare(`INSERT INTO policies (version, status, json) VALUES (?, ?, ?)
          ON CONFLICT(version) DO UPDATE SET status = excluded.status, json = excluded.json`)
          .run(p.version, p.status, toJson(p.snapshot()));
      },
      nextVersion: () => {
        const row = db.prepare("SELECT MAX(version) AS v FROM policies").get() as { v: number | null };
        return (row.v ?? 0) + 1;
      },
    };

    this.tidePolicies = {
      get: (kind, key) => {
        const row = db.prepare("SELECT json FROM tide_policies WHERE kind = ? AND key = ?").get(kind, key) as { json: string } | undefined;
        return row ? fromJson<StoredTidePolicy>(row.json) : null;
      },
      list: (kind) => (kind
        ? db.prepare("SELECT json FROM tide_policies WHERE kind = ?").all(kind)
        : db.prepare("SELECT json FROM tide_policies").all()) .map((r) => fromJson<StoredTidePolicy>((r as { json: string }).json)),
      save: (p) => {
        db.prepare(`INSERT INTO tide_policies (kind, key, json) VALUES (?, ?, ?)
          ON CONFLICT(kind, key) DO UPDATE SET json = excluded.json`).run(p.kind, p.key, toJson(p));
      },
    };

    const allAudit = () => (db.prepare("SELECT json FROM audit ORDER BY seq").all() as { json: string }[])
      .map((r) => AuditEntry.restore(fromJson<AuditEntryProps>(r.json)));
    const headAudit = () => {
      const row = db.prepare("SELECT json FROM audit ORDER BY seq DESC LIMIT 1").get() as { json: string } | undefined;
      return row ? AuditEntry.restore(fromJson<AuditEntryProps>(row.json)) : null;
    };
    this.audit = {
      append: (e) => this.transaction(() => {
        const entry = AuditEntry.next(headAudit(), e);
        db.prepare("INSERT INTO audit (seq, json) VALUES (?, ?)").run(entry.props.seq, toJson(entry.props));
        return entry;
      }),
      head: headAudit,
      all: allAudit,
      tamper: (seq, props) => { db.prepare("UPDATE audit SET json = ? WHERE seq = ?").run(toJson(props), seq); },
    };

    this.members = {
      get: (id) => {
        const row = db.prepare("SELECT json FROM members WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? Member.restore(fromJson<MemberProps>(row.json)) : null;
      },
      list: () => (db.prepare("SELECT json FROM members").all() as { json: string }[]).map((r) => Member.restore(fromJson<MemberProps>(r.json))),
      save: (m) => {
        db.prepare("INSERT INTO members (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(m.id, toJson(m.snapshot()));
      },
      groups: () => (db.prepare("SELECT json FROM resource_groups ORDER BY id").all() as { json: string }[]).map((r) => fromJson<ResourceGroup>(r.json)),
      saveGroup: (g) => {
        db.prepare("INSERT INTO resource_groups (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(g.id, toJson(g));
      },
    };

    const joinFrom = (r: { json: string } | undefined) => (r ? JoinRequest.restore(fromJson<JoinRequestProps>(r.json)) : null);
    this.joinRequests = {
      get: (id) => joinFrom(db.prepare("SELECT json FROM join_requests WHERE id = ?").get(id) as { json: string } | undefined),
      pendingFor: (memberId) => joinFrom(db.prepare("SELECT json FROM join_requests WHERE member_id = ? AND status = 'pending' LIMIT 1").get(memberId) as { json: string } | undefined),
      latestFor: (memberId) => joinFrom(db.prepare("SELECT json FROM join_requests WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(memberId) as { json: string } | undefined),
      list: (status) => (status
        ? db.prepare("SELECT json FROM join_requests WHERE status = ? ORDER BY created_at DESC").all(status)
        : db.prepare("SELECT json FROM join_requests ORDER BY created_at DESC").all()).map((r) => joinFrom(r as { json: string })!),
      save: (r) => {
        db.prepare(`INSERT INTO join_requests (id, member_id, status, created_at, json) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`)
          .run(r.id, r.memberId, r.status, r.snapshot().createdAt, toJson(r.snapshot()));
      },
    };

    this.tierTargets = {
      get: (userId) => {
        const row = db.prepare("SELECT json FROM tier_targets WHERE user_id = ?").get(userId) as { json: string } | undefined;
        return row ? fromJson<Tier[]>(row.json) : null;
      },
      set: (userId, tiers) => {
        db.prepare("INSERT INTO tier_targets (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json").run(userId, toJson(tiers));
      },
      clear: (userId) => { db.prepare("DELETE FROM tier_targets WHERE user_id = ?").run(userId); },
    };
  }

  close(): void {
    this.db.close();
  }
}
