import { secureFetch } from "@/tide/tide";
import type {
  AuditRow, AuditVerification, DirectoryMember, Doc, Group, JoinRequest, Me, PendingChange, Policy, PolicyRule,
  ServerConfig, SigningRequest, Tier, TideSetup,
} from "./types";

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
  } catch (e) {
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

export interface DraftInput {
  type: string;
  title: string;
  amountDong: string;
  resourceGroupId: string;
  sealing: string;
  sealed: { counterparty: string; bankAccount: string; description: string };
}

export const api = {
  config: () => call<ServerConfig>("GET", "/config"),
  me: () => call<Me>("GET", "/me"),

  documents: (q: { status?: string; type?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
    return call<Doc[]>("GET", `/documents${qs ? `?${qs}` : ""}`);
  },
  document: (id: string) => call<{ document: Doc; requests: SigningRequest[] }>("GET", `/documents/${id}`),
  createDocument: (input: DraftInput) => call<Doc>("POST", "/documents", input),
  editDocument: (id: string, patch: Partial<DraftInput>) => call<Doc>("PATCH", `/documents/${id}`, patch),
  withdraw: (id: string) => call<Doc>("POST", `/documents/${id}/withdraw`),
  submit: (id: string) => call<{ document: Doc; request: SigningRequest; signingRule: string | null }>("POST", `/documents/${id}/submit`),

  inbox: () => call<{ waitingForMe: SigningRequest[]; readyToSign: SigningRequest[]; mine: SigningRequest[] }>("GET", "/signing-requests"),
  request: (id: string) => call<{ request: SigningRequest; signingRule: string | null }>("GET", `/signing-requests/${id}`),
  openOnTide: (id: string, request: string) => call<SigningRequest>("POST", `/signing-requests/${id}/tide-request`, { request }),
  /** The hash goes in the PATH so the device's DPoP proof covers exactly what the approver saw. */
  approve: (id: string, contentHash: string, body: { request?: string; baseVersion?: number }) =>
    call<SigningRequest>("POST", `/signing-requests/${id}/approve/${contentHash}`, body),
  reject: (id: string, reason: string) => call<SigningRequest>("POST", `/signing-requests/${id}/reject`, { reason }),
  recordSignature: (id: string, signature: string) => call<{ request: SigningRequest; document: Doc }>("POST", `/signing-requests/${id}/signature`, { signature }),

  policies: () => call<Policy[]>("GET", "/policy"),
  proposePolicy: (rules: PolicyRule[], reason: string) => call<Policy>("POST", "/policy/drafts", { rules, reason }),
  endorsePolicy: (version: number) => call<Policy>("POST", `/policy/${version}/endorse`),
  activatePolicy: (version: number) => call<Policy>("POST", `/policy/${version}/activate`),

  tideSetup: () => call<TideSetup>("GET", "/tide/setup"),
  adminPolicy: () => call<{ policy: string }>("GET", "/tide/admin-policy"),
  storeRuleSignature: (version: number, ruleId: string, signature: string) =>
    call<{ key: string; signatureVerified: boolean }>("POST", `/tide/rules/${version}/${ruleId}`, { signature }),
  storeSealedSignature: (signature: string) => call<{ key: string; signatureVerified: boolean }>("POST", "/tide/sealed-fields", { signature }),
  sealedPolicy: () => call<{ policy: string }>("GET", "/tide/sealed-fields"),

  members: () => call<{ members: DirectoryMember[]; pendingChanges: PendingChange[]; joinRequests: JoinRequest[]; groups: Group[]; tideConsoleUrl: string }>("GET", "/members"),
  continueTiers: (userId: string) => call<{ status: string; detail: string; remaining?: string[] }>("POST", `/members/${userId}/tier/continue`),
  fileJoinRequest: (input: { requestedTier: string; note?: string; email?: string; name?: string }) => call<JoinRequest>("POST", "/join-requests", input),
  myJoinRequest: () => call<{ request: JoinRequest | null }>("GET", "/join-requests/mine"),
  decideJoinRequest: (id: string, decision: "approve" | "reject", note?: string) =>
    call<{ request: JoinRequest; outcome: { status: string; detail: string; remaining?: string[] } | null }>("POST", `/join-requests/${id}/decision`, { decision, note }),
  setTiers: (userId: string, tiers: Tier[]) => call<{ status: string; detail: string; remaining?: string[] }>("POST", `/members/${userId}/tier`, { tiers }),
  invite: (input: { firstName: string; lastName: string; email?: string }) => call<{ status: string; detail: string; userId: string | null }>("POST", "/members/invite", input),
  inviteLink: (userId: string) => call<{ link: string }>("POST", `/members/${userId}/invite-link`),
  setGroups: (memberId: string, groups: string[]) => call<unknown>("POST", `/members/${memberId}/groups`, { groups }),
  groups: () => call<Group[]>("GET", "/groups"),
  createGroup: (g: { id: string; name: string; costCentre: string }) => call<Group>("POST", "/groups", g),

  audit: (documentId?: string) => call<AuditRow[]>("GET", `/audit${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ""}`),
  verifyAudit: () => call<AuditVerification>("GET", "/audit/verify"),
  exportAudit: () => call<unknown>("GET", "/audit/export"),
};
