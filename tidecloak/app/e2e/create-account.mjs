// Create one demo person's Tide account from their invite link, waiting for each sign-up stage.
// Credentials go to the (gitignored) accounts file BEFORE anything is submitted.
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";

const [linksPath, accountsPath, who, out, mode = "explore", recoveryEmail = ""] = process.argv.slice(2);
const link = JSON.parse(readFileSync(linksPath, "utf8"))[who];
const accounts = existsSync(accountsPath) ? JSON.parse(readFileSync(accountsPath, "utf8")) : {};
if (!accounts[who] || accounts[who].reset) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const pw = Array.from({ length: 18 }, () => alphabet[randomInt(alphabet.length)]).join("") + "!7a";
  accounts[who] = { tideUsername: `sg-${who}-${randomBytes(4).toString("hex")}`, password: pw, createdAt: new Date().toISOString() };
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2) + "\n");
}
const { tideUsername, password } = accounts[who];
console.log("account:", who, "->", tideUsername);

const browser = await chromium.launch();
const ctx = await browser.newContext();
// The Tide enclave (public origin) calls TideCloak on localhost: Chrome's Local Network Access
// permission. A person sees a prompt; the headless browser is granted it up front.
await ctx.grantPermissions(["local-network-access"]);
const page = await ctx.newPage();
ctx.on("page", (p) => console.log("[popup]", p.url().slice(0, 100)));
ctx.on("requestfailed", (r) => { if (!r.url().includes("/images/")) console.log("[requestfailed]", r.url().slice(0, 120), r.failure()?.errorText); });

let n = 0;
async function dump(label) {
  n++;
  await page.screenshot({ path: `${out}/${who}-${n}-${label}.png`, fullPage: true }).catch(() => {});
  const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+/g, " ").slice(0, 500);
  const visible = await page.$$eval("input, button, a, [id$='-button']", (els) => els.filter((e) => e.offsetParent !== null).map((e) =>
    `${e.tagName.toLowerCase()}#${e.id || "-"}[${e.type || ""}] "${(e.innerText || e.value || e.placeholder || "").trim().slice(0, 30)}"`)).catch(() => []);
  console.log(`\n== ${n}-${label}\n text: ${text}\n visible: ${visible.join(" | ")}`);
}
const visibleNow = (sel) => page.locator(sel).first().isVisible().catch(() => false);
async function waitFor(sel, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await visibleNow(sel)) return true;
    if (await visibleNow("#createUserError-report-btn")) return false;
    await page.waitForTimeout(500);
  }
  return false;
}

await page.goto(link, { waitUntil: "networkidle" });
await page.getByText("Link Account").click();
await page.waitForURL(/tideprotocol\.com/, { timeout: 60000 });
await page.getByText(/create an account/i).first().click();
await page.fill("input#sign_up-input_username", tideUsername);
await page.fill("input#sign_up-input_password", password);
await page.fill("input#sign_up-input_repeat_password", password);
await page.locator("#sign_up-button").click();

if (!(await waitFor("#sign_up_email-button", 90000))) { await dump("credentials-failed"); await browser.close(); process.exit(1); }
await dump("recovery-step");
if (mode === "explore") { await browser.close(); process.exit(0); }

if (recoveryEmail) {
  const email = page.locator("input#sign_up-email-input-1");
  if (await email.isVisible().catch(() => false)) await email.fill(recoveryEmail);
}
await page.locator("#sign_up_email-button").click();
// Without an email Tide shows a "No recovery email" notice and keeps processing; wait for the end.
await page.getByText(/tide account linked/i).waitFor({ timeout: 90000 }).catch(() => {});
await dump("after-recovery");
await browser.close();
