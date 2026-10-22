import { secureFetch } from "@/tide/tide";
import type { AuditRow, AuditVerification, BoardMember, FinishKit, KeyRequest, Level, Me, ServerConfig, TideSetup, VaultKey } from "./types";

/** An error the server explained: `code` is stable, `message` is safe to show. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = secureFetch;
/** Tests swap the transport; the app always uses the DPoP-signing secureFetch. */
export const setFetcher = (f: Fetcher) => { fetcher = f; };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach SignGuard. Check your connection and try again.");
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (HTTP ${res.status})`);
  }
  return json as T;
}

export interface NewKeyInput {
  name: string;
  kind: string;
  provider: string;
  description: string;
  hint: string;
  level: Level;
  /** The encryption draft from this browser: ciphertext only. */
  request: string;
}

export interface Inbox {
  waitingForMe: KeyRequest[];
  readyToFinish: KeyRequest[];
  mine: KeyRequest[];
  recent: KeyRequest[];
}

export const api = {
  config: () => call<ServerConfig>("GET", "/config"),
  me: () => call<Me>("GET", "/me"),

  keys: () => call<VaultKey[]>("GET", "/keys"),
  key: (id: string) => call<{ key: VaultKey; requests: KeyRequest[] }>("GET", `/keys/${encodeURIComponent(id)}`),
  registerKey: (input: NewKeyInput) => call<{ key: VaultKey; request: KeyRequest }>("POST", "/keys", input),
  requestRelease: (keyId: string, body: { reason: string; request: string }) => call<KeyRequest>("POST", `/keys/${encodeURIComponent(keyId)}/release`, body),

  inbox: () => call<Inbox>("GET", "/requests"),
  request: (id: string) => call<{ request: KeyRequest; key: VaultKey | null }>("GET", `/requests/${encodeURIComponent(id)}`),
  approve: (id: string, request: string) => call<KeyRequest>("POST", `/requests/${encodeURIComponent(id)}/approve`, { request }),
  reject: (id: string, reason: string) => call<KeyRequest>("POST", `/requests/${encodeURIComponent(id)}/reject`, { reason }),
  cancel: (id: string) => call<KeyRequest>("POST", `/requests/${encodeURIComponent(id)}/cancel`),
  finishKit: (id: string) => call<FinishKit>("POST", `/requests/${encodeURIComponent(id)}/finish-kit`),
  finish: (id: string, body: { request: string; ciphertext?: string }) => call<{ request: KeyRequest; key: VaultKey }>("POST", `/requests/${encodeURIComponent(id)}/finish`, body),

  tideSetup: () => call<TideSetup>("GET", "/tide/setup"),
  adminPolicy: () => call<{ policy: string }>("GET", "/tide/admin-policy"),
  storeVaultPolicy: (threshold: number, signature: string) => call<{ key: string; signatureVerified: boolean }>("POST", `/tide/vault-policies/${threshold}`, { signature }),

  board: () => call<{ source: "tidecloak" | "sign-ins"; boardSize: number; members: BoardMember[] }>("GET", "/board"),

  audit: (keyId?: string) => call<AuditRow[]>("GET", `/audit${keyId ? `?keyId=${encodeURIComponent(keyId)}` : ""}`),
  verifyAudit: () => call<AuditVerification>("GET", "/audit/verify"),
  exportAudit: () => call<unknown>("GET", "/audit/export"),
};
