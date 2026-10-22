import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { AuthError, authenticate, type AuthOptions } from "./auth/authenticate.js";
import { DomainError } from "./domain/errors.js";
import { ApproveRequest, GetSigningRequest, InitializeTideRequest, ListPendingApprovals, RecordSignature, RejectRequest } from "./usecases/approvals.js";
import { ListAudit, VerifyAuditChain } from "./usecases/audit.js";
import type { Deps, Principal } from "./usecases/context.js";
import { CreateDraft, EditDraft, ListDocuments, SubmitForSigning, ViewDocument, WithdrawDocument } from "./usecases/documents.js";
import { ChangeTier, ContinueTierChange, CreateResourceGroup, DecideJoinRequest, FileJoinRequest, GetInviteLink, InviteMember, ListGroups, ListMembers, MyJoinRequest, RecordSignIn, SetMemberGroups } from "./usecases/members.js";
import { ActivatePolicy, EndorsePolicy, ProposePolicyChange, TideSetup, ViewPolicies } from "./usecases/policy.js";
import { presentAudit, presentDocument, presentPolicy, presentRequest } from "./routes/presenters.js";

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

type Handler = (req: Request, p: Principal) => Promise<unknown> | unknown;

export function createApp(d: Deps, auth: AuthOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } }));
  app.use(express.json({ limit: "256kb" }));

  const uc = {
    createDraft: new CreateDraft(d), editDraft: new EditDraft(d), withdraw: new WithdrawDocument(d),
    listDocuments: new ListDocuments(d), viewDocument: new ViewDocument(d), submit: new SubmitForSigning(d),
    pending: new ListPendingApprovals(d), getRequest: new GetSigningRequest(d), initTide: new InitializeTideRequest(d),
    approve: new ApproveRequest(d), reject: new RejectRequest(d), recordSignature: new RecordSignature(d),
    policies: new ViewPolicies(d), propose: new ProposePolicyChange(d), endorse: new EndorsePolicy(d), activate: new ActivatePolicy(d),
    tideSetup: new TideSetup(d), signIn: new RecordSignIn(d), members: new ListMembers(d), changeTier: new ChangeTier(d),
    invite: new InviteMember(d), inviteLink: new GetInviteLink(d), setGroups: new SetMemberGroups(d), continueTier: new ContinueTierChange(d),
    fileJoin: new FileJoinRequest(d), myJoin: new MyJoinRequest(d), decideJoin: new DecideJoinRequest(d),
    createGroup: new CreateResourceGroup(d), groups: new ListGroups(d), audit: new ListAudit(d), verifyAudit: new VerifyAuditChain(d),
  };

  /** Every route below verifies the Tide token AND the device's DPoP proof before doing anything. */
  const route = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = await authenticate({
        method: req.method,
        path: req.originalUrl.split("?")[0]!,
        authorization: req.header("authorization"),
        dpop: req.header("dpop"),
      }, auth);
      req.principal = principal;
      const out = await h(req, principal);
      res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

  const api = express.Router();
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const param = (req: Request, name: string) => {
    const v = req.params[name];
    if (typeof v !== "string" || !v) throw new DomainError("INVALID", `Missing ${name}`, 400);
    return v;
  };
  const num = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new DomainError("INVALID", "Expected a positive integer", 400);
    return n;
  };

  api.get("/health", (_req, res) => { res.json({ ok: true }); });
  api.get("/config", (_req, res) => {
    res.json({ org: d.settings.org, tideConsoleUrl: d.settings.tideConsoleUrl, allowUnsignedDev: d.settings.allowUnsignedDev, allowPlaintextDev: d.settings.allowPlaintextDev });
  });

  // --- me ---
  api.get("/me", route((_req, p) => {
    const member = uc.signIn.execute(p);
    return { ...p, displayName: member.displayName(), resourceGroups: member.resourceGroups };
  }));

  // --- documents ---
  api.get("/documents", route((req, p) => uc.listDocuments.execute(p, { status: str(req.query.status), type: str(req.query.type), resourceGroupId: str(req.query.group) }).map(presentDocument)));
  api.post("/documents", route((req, p) => presentDocument(uc.createDraft.execute(p, req.body ?? {}))));
  api.get("/documents/:id", route((req, p) => {
    const { document, requests } = uc.viewDocument.execute(p, param(req, "id"));
    return { document: presentDocument(document), requests: requests.map(presentRequest) };
  }));
  api.patch("/documents/:id", route((req, p) => presentDocument(uc.editDraft.execute(p, param(req, "id"), req.body ?? {}))));
  api.post("/documents/:id/withdraw", route((req, p) => presentDocument(uc.withdraw.execute(p, param(req, "id")))));
  api.post("/documents/:id/submit", route((req, p) => {
    const out = uc.submit.execute(p, param(req, "id"));
    return { document: presentDocument(out.document), request: presentRequest(out.request), signingRule: out.signingRule };
  }));

  // --- signing requests ---
  api.get("/signing-requests", route((_req, p) => {
    const out = uc.pending.execute(p);
    return { waitingForMe: out.waitingForMe.map(presentRequest), readyToSign: out.readyToSign.map(presentRequest), mine: out.mine.map(presentRequest) };
  }));
  api.get("/signing-requests/:id", route((req, p) => {
    const out = uc.getRequest.execute(p, param(req, "id"));
    return { request: presentRequest(out.request), signingRule: out.signingRule };
  }));
  api.post("/signing-requests/:id/tide-request", route((req, p) => presentRequest(uc.initTide.execute(p, param(req, "id"), String(req.body?.request ?? "")))));
  // The content hash is in the PATH so the approver's DPoP proof (signed by their device) covers it.
  api.post("/signing-requests/:id/approve/:contentHash", route(async (req, p) => presentRequest(await uc.approve.execute(p, param(req, "id"), {
    contentHash: param(req, "contentHash"), request: str(req.body?.request), baseVersion: typeof req.body?.baseVersion === "number" ? req.body.baseVersion : undefined,
  }))));
  api.post("/signing-requests/:id/reject", route((req, p) => presentRequest(uc.reject.execute(p, param(req, "id"), String(req.body?.reason ?? "")))));
  api.post("/signing-requests/:id/signature", route(async (req, p) => {
    const out = await uc.recordSignature.execute(p, param(req, "id"), String(req.body?.signature ?? ""));
    return { request: presentRequest(out.request), document: presentDocument(out.document) };
  }));

  // --- policy ---
  api.get("/policy", route((_req, p) => uc.policies.execute(p).map((x) => presentPolicy(x.policy, x.networkRules))));
  api.post("/policy/drafts", route((req, p) => presentPolicy(uc.propose.execute(p, req.body ?? {}))));
  api.post("/policy/:version/endorse", route((req, p) => presentPolicy(uc.endorse.execute(p, num(param(req, "version"))))));
  api.post("/policy/:version/activate", route((req, p) => presentPolicy(uc.activate.execute(p, num(param(req, "version"))))));

  // --- Tide setup ---
  api.get("/tide/setup", route((_req, p) => uc.tideSetup.status(p)));
  api.get("/tide/admin-policy", route(async (_req, p) => ({ policy: await uc.tideSetup.adminPolicy(p) })));
  api.post("/tide/rules/:version/:ruleId", route((req, p) => uc.tideSetup.storeRuleSignature(p, num(param(req, "version")), param(req, "ruleId"), String(req.body?.signature ?? ""))));
  api.post("/tide/sealed-fields", route((req, p) => uc.tideSetup.storeSealedSignature(p, String(req.body?.signature ?? ""))));
  api.get("/tide/sealed-fields", route((_req, p) => ({ policy: uc.tideSetup.sealedPolicy(p) })));

  // --- members ---
  api.get("/members", route((_req, p) => uc.members.execute(p)));
  api.post("/members/invite", route((req, p) => uc.invite.execute(p, req.body ?? {})));
  api.post("/members/:id/tier", route((req, p) => uc.changeTier.execute(p, param(req, "id"), req.body?.tiers)));
  api.post("/members/:id/tier/continue", route((req, p) => uc.continueTier.execute(p, param(req, "id"))));

  // --- sign-up: join requests (any signed-in Tide user, member or not) ---
  api.post("/join-requests", route((req, p) => uc.fileJoin.execute(p, req.body ?? {}).snapshot()));
  api.get("/join-requests/mine", route((_req, p) => ({ request: uc.myJoin.execute(p)?.snapshot() ?? null })));
  api.post("/join-requests/:id/decision", route(async (req, p) => {
    const out = await uc.decideJoin.execute(p, param(req, "id"), req.body?.decision, req.body?.note);
    return { request: out.request.snapshot(), outcome: out.outcome };
  }));
  api.post("/members/:id/invite-link", route((req, p) => uc.inviteLink.execute(p, param(req, "id"))));
  api.post("/members/:id/groups", route((req, p) => uc.setGroups.execute(p, param(req, "id"), req.body?.groups).snapshot()));
  api.get("/groups", route((_req, p) => uc.groups.execute(p)));
  api.post("/groups", route((req, p) => uc.createGroup.execute(p, req.body ?? {})));

  // --- audit ---
  api.get("/audit", route((req, p) => uc.audit.execute(p, { documentId: str(req.query.documentId) }).map(presentAudit)));
  api.get("/audit/verify", route((_req, p) => uc.verifyAudit.execute(p)));
  api.get("/audit/export", route(async (_req, p) => ({
    exportedAt: d.clock.now().toISOString(),
    org: d.settings.org,
    verification: await uc.verifyAudit.execute(p),
    entries: uc.audit.execute(p).map(presentAudit),
    signedStatements: d.requests.list({ status: ["signed"] }).map((r) => ({ requestId: r.id, documentId: r.documentId, statement: r.statement, receipts: r.snapshot().receipts })),
    realmKeys: d.tide.realmKeys,
    mockCaKey: await d.ca.publicKeyJwk(),
  })));

  app.use("/api", api);
  app.use("/api", (_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "No such API route" } }); });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AuthError) return res.status(err.status).json({ error: { code: err.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message: err.message } });
    if (err instanceof DomainError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof SyntaxError && "body" in (err as object)) return res.status(400).json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON" } });
    console.error(err);
    return res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on the server" } });
  });

  return app;
}
