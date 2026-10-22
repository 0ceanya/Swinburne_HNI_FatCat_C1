import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RealmKeys } from "./tide/signatures.js";

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** tidecloak/ : holds .env (operator secrets) and tidecloak.json (the adapter) written by bootstrap.py */
const TIDECLOAK_DIR = resolve(BACKEND_DIR, "..", "..");

/** Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. Never overrides real env vars. */
export function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

export interface ServerConfig {
  port: number;
  dbPath: string;
  caKeyPath: string;
  adapter: Record<string, unknown>;
  adapterPath: string;
  vendorId: string;
  clientId: string;
  realm: string;
  authServerUrl: string;
  realmKeys: RealmKeys;
  allowedOrigins: string[];
  org: { name: string; taxCode: string };
  allowUnsignedDev: boolean;
  allowPlaintextDev: boolean;
  requireDpop: boolean;
  admin: { username: string; password: string } | null;
  tideConsoleUrl: string;
}

const bool = (v: string | undefined) => v === "true" || v === "1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const fileEnv = { ...loadEnvFile(resolve(TIDECLOAK_DIR, ".env")), ...loadEnvFile(resolve(BACKEND_DIR, ".env")) };
  const get = (k: string) => env[k] ?? fileEnv[k];

  const adapterPath = resolve(get("TIDECLOAK_ADAPTER") ?? resolve(TIDECLOAK_DIR, "tidecloak.json"));
  if (!existsSync(adapterPath)) {
    throw new Error(`TideCloak adapter not found at ${adapterPath}. Run tidecloak/bootstrap.py first, or set TIDECLOAK_ADAPTER.`);
  }
  const adapter = JSON.parse(readFileSync(adapterPath, "utf8")) as Record<string, unknown>;
  const jwk = adapter.jwk as { keys?: RealmKeys } | undefined;
  for (const field of ["vendorId", "realm", "resource", "auth-server-url"]) {
    if (typeof adapter[field] !== "string") throw new Error(`tidecloak.json has no ${field}. Re-export the adapter; do not hand-edit it.`);
  }
  if (!jwk?.keys?.length) throw new Error("tidecloak.json has no embedded jwk: the realm is not licensed. Re-run bootstrap.");

  const origins = (get("CLIENT_APP_URLS") ?? get("CLIENT_APP_URL") ?? "http://localhost:5173")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const authServerUrl = String(adapter["auth-server-url"]).replace(/\/+$/, "");
  const password = get("KC_BOOTSTRAP_ADMIN_PASSWORD") ?? get("KC_ADMIN_PASSWORD");

  return {
    port: Number(get("SIGNGUARD_PORT") ?? 3000),
    dbPath: resolve(get("SIGNGUARD_DB") ?? resolve(BACKEND_DIR, "data", "signguard.db")),
    caKeyPath: resolve(get("SIGNGUARD_CA_KEY") ?? resolve(BACKEND_DIR, "data", "mock-ca-key.json")),
    adapter,
    adapterPath,
    vendorId: String(adapter.vendorId),
    clientId: String(adapter.resource),
    realm: String(adapter.realm),
    authServerUrl,
    realmKeys: jwk.keys,
    allowedOrigins: origins,
    org: { name: get("SIGNGUARD_ORG_NAME") ?? "Công ty TNHH SignGuard Demo", taxCode: get("SIGNGUARD_ORG_TAX_CODE") ?? "0312345678" },
    allowUnsignedDev: bool(get("SIGNGUARD_ALLOW_UNSIGNED_DEV")),
    allowPlaintextDev: bool(get("SIGNGUARD_ALLOW_PLAINTEXT_DEV")),
    requireDpop: get("SIGNGUARD_REQUIRE_DPOP") !== "false",
    admin: password ? { username: get("KC_BOOTSTRAP_ADMIN_USERNAME") ?? get("KC_ADMIN_USER") ?? "admin", password } : null,
    tideConsoleUrl: `${authServerUrl}/realms/${String(adapter.realm)}/tide-console/`,
  };
}
