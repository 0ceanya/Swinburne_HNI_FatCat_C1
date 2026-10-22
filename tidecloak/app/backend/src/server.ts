import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildContainer } from "./container.js";

const cfg = loadConfig();
const { deps, auth } = buildContainer(cfg);
const app = createApp(deps, auth);

app.listen(cfg.port, "127.0.0.1", () => {
  console.log(`SignGuard API on http://127.0.0.1:${cfg.port}/api`);
  console.log(`  realm ${cfg.realm} at ${cfg.authServerUrl}, client ${cfg.clientId}`);
  console.log(`  browser origins: ${cfg.allowedOrigins.join(", ")}`);
  console.log(`  board of ${cfg.boardSize}: a key's quorum is its level (1-4), capped at ${cfg.boardSize}`);
  console.log(`  board list + Tide setup: ${deps.directory.available ? "read-only TideCloak admin credential from tidecloak/.env (local dev)" : "no admin credential: board from sign-ins, Tide setup view-only"}`);
  if (!cfg.requireDpop) console.warn("  WARNING: SIGNGUARD_REQUIRE_DPOP=false: tokens are not bound to devices.");
});
