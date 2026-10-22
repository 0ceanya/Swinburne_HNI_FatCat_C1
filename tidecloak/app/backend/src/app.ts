import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { AuthError, authenticate, type AuthOptions } from "./auth/authenticate.js";
import { DomainError } from "./domain/errors.js";
import { ListAudit, VerifyAuditChain } from "./usecases/audit.js";
import { ListBoard, RecordSignIn } from "./usecases/board.js";
import type { Deps, Principal } from "./usecases/context.js";
import { TideSetup } from "./usecases/tideSetup.js";
import {
  ApproveRequest, CancelRequest, FinishKit, FinishRequest, GetRequest, Inbox, ListKeys, RegisterKey, RejectRequest, RequestRelease, vaultCatalog, ViewKey,
} from "./usecases/vault.js";
import { presentAudit, presentKey, presentRequest } from "./routes/presenters.js";

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
  app.use(express.json({ limit: "512kb" }));

  const uc = {
    register: new RegisterKey(d), keys: new ListKeys(d), key: new ViewKey(d), release: new RequestRelease(d),
    inbox: new Inbox(d), request: new GetRequest(d), approve: new ApproveRequest(d), reject: new RejectRequest(d),
    cancel: new CancelRequest(d), kit: new FinishKit(d), finish: new FinishRequest(d),
    tideSetup: new TideSetup(d), signIn: new RecordSignIn(d), board: new ListBoard(d), audit: new ListAudit(d), verifyAudit: new VerifyAuditChain(d),
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
    res.json({ org: d.settings.org, tideConsoleUrl: d.settings.tideConsoleUrl, ...vaultCatalog(d) });
  });

  // --- me ---
  api.get("/me", route((_req, p) => {
    const member = uc.signIn.execute(p);
    return { ...p, displayName: member.displayName() };
  }));

  // --- vault keys ---
  api.get("/keys", route((_req, p) => uc.keys.execute(p).map(presentKey)));
  api.post("/keys", route((req, p) => {
    const out = uc.register.execute(p, req.body ?? {});
    return { key: presentKey(out.key), request: presentRequest(out.request) };
  }));
  api.get("/keys/:id", route((req, p) => {
    const out = uc.key.execute(p, param(req, "id"));
    return { key: presentKey(out.key), requests: out.requests.map(presentRequest) };
  }));
  api.post("/keys/:id/release", route((req, p) => presentRequest(uc.release.execute(p, param(req, "id"), req.body ?? {}))));

  // --- requests (seal or release) ---
  api.get("/requests", route((_req, p) => {
    const out = uc.inbox.execute(p);
    return {
      waitingForMe: out.waitingForMe.map(presentRequest), readyToFinish: out.readyToFinish.map(presentRequest),
      mine: out.mine.map(presentRequest), recent: out.recent.map(presentRequest),
    };
  }));
  api.get("/requests/:id", route((req, p) => {
    const out = uc.request.execute(p, param(req, "id"));
    return { request: presentRequest(out.request), key: out.key ? presentKey(out.key) : null };
  }));
  api.post("/requests/:id/approve", route(async (req, p) => presentRequest(await uc.approve.execute(p, param(req, "id"), { request: req.body?.request }))));
  api.post("/requests/:id/reject", route((req, p) => presentRequest(uc.reject.execute(p, param(req, "id"), String(req.body?.reason ?? "")))));
  api.post("/requests/:id/cancel", route((req, p) => presentRequest(uc.cancel.execute(p, param(req, "id")))));
  api.post("/requests/:id/finish-kit", route((req, p) => uc.kit.execute(p, param(req, "id"))));
  api.post("/requests/:id/finish", route(async (req, p) => {
    const out = await uc.finish.execute(p, param(req, "id"), { request: req.body?.request, ciphertext: req.body?.ciphertext });
    return { request: presentRequest(out.request), key: presentKey(out.key) };
  }));

  // --- Tide setup ---
  api.get("/tide/setup", route((_req, p) => uc.tideSetup.status(p)));
  api.get("/tide/admin-policy", route(async (_req, p) => ({ policy: await uc.tideSetup.adminPolicy(p) })));
  api.post("/tide/vault-policies/:threshold", route((req, p) => uc.tideSetup.storeVaultPolicy(p, num(param(req, "threshold")), String(req.body?.signature ?? ""))));

  // --- board (read-only) ---
  api.get("/board", route((_req, p) => uc.board.execute(p)));

  // --- audit ---
  api.get("/audit", route((req, p) => uc.audit.execute(p, { keyId: str(req.query.keyId) }).map(presentAudit)));
  api.get("/audit/verify", route((_req, p) => uc.verifyAudit.execute(p)));
  api.get("/audit/export", route((_req, p) => ({
    exportedAt: d.clock.now().toISOString(),
    org: d.settings.org,
    verification: uc.verifyAudit.execute(p),
    entries: uc.audit.execute(p).map(presentAudit),
    realmKeys: d.tide.realmKeys,
  })));

  app.use("/api", api);
  app.use("/api", (_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "No such API route" } }); });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AuthError) return res.status(err.status).json({ error: { code: err.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message: err.message } });
    if (err instanceof DomainError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err instanceof SyntaxError && "body" in (err as object)) return res.status(400).json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON" } });
    if ((err as { type?: string })?.type === "entity.too.large") return res.status(413).json({ error: { code: "TOO_LARGE", message: "Request is too large" } });
    console.error(err);
    return res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on the server" } });
  });

  return app;
}
