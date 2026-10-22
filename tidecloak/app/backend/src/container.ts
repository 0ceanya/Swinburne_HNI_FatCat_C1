import type { AuthOptions } from "./auth/authenticate.js";
import { MemoryJtiStore } from "./auth/dpop.js";
import type { ServerConfig } from "./config.js";
import { MockCa } from "./gateways/mockCa.js";
import { TideCloakDirectory, unavailableDirectory } from "./gateways/tideDirectory.js";
import { randomIds, systemClock } from "./gateways/util.js";
import { SqliteStore } from "./persistence/sqlite.js";
import type { Deps } from "./usecases/context.js";
import { bootstrapPolicy, ensureDefaultGroup } from "./usecases/policy.js";
import type { Clock, IdGenerator, TideDirectory } from "./usecases/ports.js";

export interface Overrides {
  clock?: Clock;
  ids?: IdGenerator;
  directory?: TideDirectory;
  caKeyPath?: string | null;
}

/** Wire the real adapters behind the use-case ports. Tests pass overrides for clock and directory. */
export function buildContainer(cfg: ServerConfig, o: Overrides = {}): { deps: Deps; auth: AuthOptions; store: SqliteStore } {
  const store = new SqliteStore(cfg.dbPath);
  const clock = o.clock ?? systemClock;
  const deps: Deps = {
    documents: store.documents,
    requests: store.requests,
    policies: store.policies,
    tidePolicies: store.tidePolicies,
    audit: store.audit,
    members: store.members,
    joinRequests: store.joinRequests,
    tierTargets: store.tierTargets,
    transaction: store.transaction,
    clock,
    ids: o.ids ?? randomIds,
    tide: { vendorId: cfg.vendorId, clientId: cfg.clientId, realm: cfg.realm, authServerUrl: cfg.authServerUrl, realmKeys: cfg.realmKeys },
    ca: new MockCa(o.caKeyPath === undefined ? cfg.caKeyPath : o.caKeyPath, cfg.realmKeys, () => clock.now()),
    directory: o.directory ?? (cfg.admin ? new TideCloakDirectory(cfg.authServerUrl, cfg.realm, cfg.admin) : unavailableDirectory),
    settings: { org: cfg.org, allowUnsignedDev: cfg.allowUnsignedDev, allowPlaintextDev: cfg.allowPlaintextDev, tideConsoleUrl: cfg.tideConsoleUrl },
  };
  bootstrapPolicy(deps);
  ensureDefaultGroup(deps);
  const auth: AuthOptions = {
    adapter: cfg.adapter,
    requireDpop: cfg.requireDpop,
    dpop: { allowedOrigins: cfg.allowedOrigins, jtiStore: new MemoryJtiStore(), now: () => clock.now().getTime() / 1000 },
  };
  return { deps, auth, store };
}
