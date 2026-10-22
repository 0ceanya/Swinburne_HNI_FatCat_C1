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
  console.log(`  member management: ${deps.directory.available ? "on (TideCloak admin credential from tidecloak/.env, local dev)" : "off (no admin credential)"}`);
  if (cfg.allowUnsignedDev) console.warn("  WARNING: SIGNGUARD_ALLOW_UNSIGNED_DEV=true: approvals can complete without the Tide network.");
  if (cfg.allowPlaintextDev) console.warn("  WARNING: SIGNGUARD_ALLOW_PLAINTEXT_DEV=true: sensitive fields may be stored unencrypted.");
  if (!cfg.requireDpop) console.warn("  WARNING: SIGNGUARD_REQUIRE_DPOP=false: tokens are not bound to devices.");
});
