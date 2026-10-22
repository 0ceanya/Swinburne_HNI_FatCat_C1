import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditEntry, type AuditEntryProps } from "../domain/auditEntry.js";
import { KeyRequest, type KeyRequestProps } from "../domain/keyRequest.js";
import { Member, type MemberProps } from "../domain/member.js";
import { VaultKey, type VaultKeyProps } from "../domain/vaultKey.js";
import type {
  AuditLog, KeyRequestRepository, MemberRepository, StoredTidePolicy, TidePolicyRepository, UnitOfWork, VaultKeyRepository,
} from "../usecases/ports.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_keys (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS key_requests (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_key_requests_key ON key_requests(key_id);
CREATE TABLE IF NOT EXISTS tide_policies (kind TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (kind, key));
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, json TEXT NOT NULL);
`;

const toJson = (v: unknown) => JSON.stringify(v);
const fromJson = <T>(s: string): T => JSON.parse(s) as T;

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly keys: VaultKeyRepository;
  readonly requests: KeyRequestRepository;
  readonly tidePolicies: TidePolicyRepository;
  readonly audit: AuditLog;
  readonly members: MemberRepository;
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

    this.keys = {
      get: (id) => {
        const row = db.prepare("SELECT json FROM vault_keys WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? VaultKey.restore(fromJson<VaultKeyProps>(row.json)) : null;
      },
      list: (f = {}) => {
        const rows = (f.status
          ? db.prepare("SELECT json FROM vault_keys WHERE status = ? ORDER BY created_at DESC").all(f.status)
          : db.prepare("SELECT json FROM vault_keys ORDER BY created_at DESC").all()) as { json: string }[];
        return rows.map((r) => VaultKey.restore(fromJson<VaultKeyProps>(r.json)));
      },
      save: (k) => {
        const p = k.snapshot();
        db.prepare(`INSERT INTO vault_keys (id, status, created_at, json) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`).run(p.id, p.status, p.createdAt, toJson(p));
      },
    };

    this.requests = {
      get: (id) => {
        const row = db.prepare("SELECT json FROM key_requests WHERE id = ?").get(id) as { json: string } | undefined;
        return row ? KeyRequest.restore(fromJson<KeyRequestProps>(row.json)) : null;
      },
      list: (f = {}) => {
        const where: string[] = [];
        const args: string[] = [];
        if (f.keyId) { where.push("key_id = ?"); args.push(f.keyId); }
        if (f.status?.length) { where.push(`status IN (${f.status.map(() => "?").join(",")})`); args.push(...f.status); }
        const sql = `SELECT json FROM key_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rowid DESC`;
        return (db.prepare(sql).all(...args) as { json: string }[]).map((r) => KeyRequest.restore(fromJson<KeyRequestProps>(r.json)));
      },
      save: (r) => {
        db.prepare(`INSERT INTO key_requests (id, key_id, status, json) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json`)
          .run(r.id, r.keyId, r.status, toJson(r.snapshot()));
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
    };
  }

  close(): void {
    this.db.close();
  }
}
