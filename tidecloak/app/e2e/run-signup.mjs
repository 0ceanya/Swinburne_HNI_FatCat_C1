// A new person signs up on SignGuard's own page; Tide creates their key; a join request is filed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { ACCOUNTS, APP, launch, shot, textOf } from "./lib.mjs";

const [out, who = "newcomer", lastName = "Phạm Thị", firstName = "Hoa", tier = "drafter"] = process.argv.slice(2);
const accounts = existsSync(ACCOUNTS) ? JSON.parse(readFileSync(ACCOUNTS, "utf8")) : {};
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
accounts[who] = { tideUsername: `sg-${who}-${randomBytes(4).toString("hex")}`, password: Array.from({ length: 18 }, () => alphabet[randomInt(alphabet.length)]).join("") + "!7a", createdAt: new Date().toISOString() };
writeFileSync(ACCOUNTS, JSON.stringify(accounts, null, 2) + "\n");
const { tideUsername, password } = accounts[who];

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.grantPermissions(["local-network-access"]);
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error" && !/images\/|requestStorageAccess|db failed/.test(m.text())) console.log("[console]", m.text().slice(0, 240)); });

await page.goto(`${APP}/signup`, { waitUntil: "networkidle" });
await shot(page, out, "signup-1-form");
await page.fill("#su-last", lastName);
await page.fill("#su-first", firstName);
await page.check(`input[name=tier][value=${tier}]`);
await page.fill("#su-note", "Kế toán chi nhánh Cần Thơ");
await page.getByRole("button", { name: /continue to tide/i }).click();

await page.waitForURL(/tideprotocol\.com/, { timeout: 60000 });
await page.getByText(/create an account/i).first().waitFor({ timeout: 60000 });
await shot(page, out, "signup-2-tide");
await page.getByText(/create an account/i).first().click();
await page.fill("input#sign_up-input_username", tideUsername);
await page.fill("input#sign_up-input_password", password);
await page.fill("input#sign_up-input_repeat_password", password);
await page.locator("#sign_up-button").click();
for (let i = 0; i < 18; i++) {
  if (await page.locator("#sign_up_email-button").isVisible().catch(() => false)) break;
  await page.waitForTimeout(5000);
  const t = (await textOf(page)).slice(0, 300);
  console.log(`t+${(i + 1) * 5}s:`, t);
  if (/error/i.test(t)) { await shot(page, out, "signup-error"); break; }
}
await page.locator("#sign_up_email-button").click();
try { await page.waitForURL((u) => u.toString().startsWith(APP), { timeout: 150000 }); }
catch { await shot(page, out, "signup-stuck"); console.log("STUCK AT:", page.url().slice(0, 100), " || ", (await textOf(page)).slice(0, 600)); await browser.close(); process.exit(1); }
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(5000);
console.log("BACK IN APP:", page.url());
console.log("PAGE:", (await textOf(page)).slice(0, 700));
await shot(page, out, "signup-3-joined");
await browser.close();
