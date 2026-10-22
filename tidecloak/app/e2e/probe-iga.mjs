// Can the owner's own (DPoP-bound) token call TideCloak's IGA API from the browser?
import { launch, signIn } from "./lib.mjs";

const out = process.argv[2];
const browser = await launch();
const { page } = await signIn(browser, "owner", { out });
await page.waitForFunction(() => !!window.__signguardTide, null, { timeout: 30000 });
const result = await page.evaluate(async () => {
  const t = window.__signguardTide;
  const base = "http://localhost:8081/admin/realms/signguard";
  const out = {};
  for (const path of ["/iga/change-requests?status=PENDING", "/users?max=3", "/iga/role-policies"]) {
    try {
      const r = await t.secureFetch(base + path, { headers: { Accept: "application/json" } });
      out[path] = `${r.status} ${(await r.text()).slice(0, 160)}`;
    } catch (e) { out[path] = "THREW " + e.message; }
  }
  out.roles = JSON.stringify(t.claim("resource_access")).slice(0, 300);
  return out;
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
