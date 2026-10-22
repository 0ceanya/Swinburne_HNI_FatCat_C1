/**
 * File a tier change for a TideCloak user, as a change request a realm admin must approve.
 *
 *   npm run grant -w backend -- <username> owner,director,drafter,viewer
 *
 * For bootstrapping: the first owner needs tiers before the Members screen is available to them.
 * Uses the master-admin credential in tidecloak/.env (local dev). On this IGA realm nothing changes
 * until a realm admin signs the request in the Tide console (Change Requests).
 */
import { loadConfig } from "../config.js";
import { isTier, type Tier } from "../domain/tier.js";
import { rolesForTiers, TideCloakDirectory } from "../gateways/tideDirectory.js";

const [username, tierList] = process.argv.slice(2);
if (!username || !tierList) {
  console.error("usage: npm run grant -w backend -- <username> owner,director,drafter,viewer");
  process.exit(2);
}
const tiers = tierList.split(",").map((t) => t.trim());
if (!tiers.every(isTier)) {
  console.error(`unknown tier in "${tierList}". Tiers: viewer, drafter, approver, director, owner`);
  process.exit(2);
}

const cfg = loadConfig();
if (!cfg.admin) {
  console.error("No KC_BOOTSTRAP_ADMIN_PASSWORD in tidecloak/.env");
  process.exit(2);
}
const directory = new TideCloakDirectory(cfg.authServerUrl, cfg.realm, cfg.admin);
const user = (await directory.listUsers()).find((u) => u.username === username);
if (!user) {
  console.error(`No user "${username}" in realm ${cfg.realm}`);
  process.exit(1);
}
console.log(`${username}: wants roles ${rolesForTiers(tiers as Tier[]).join(", ")}`);
console.log(`TideCloak allows one pending change per user, so each role is one approval at ${cfg.tideConsoleUrl} (Change Requests).`);
console.log("This keeps filing the next change after you approve each one. Ctrl+C to stop; re-run any time.\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  const outcome = await directory.setTiers(user.id, tiers as Tier[]);
  console.log(`${outcome.status}: ${outcome.detail}`);
  if (outcome.status !== "pending") break;
  process.stdout.write("  waiting for approval in the Tide console");
  while ((await directory.pendingChanges()).some((c) => c.entityId === user.id)) {
    process.stdout.write(".");
    await sleep(5000);
  }
  console.log(" approved.");
}
console.log(`\nDone. ${username} must sign out and in again for the new roles to appear in their token.`);
