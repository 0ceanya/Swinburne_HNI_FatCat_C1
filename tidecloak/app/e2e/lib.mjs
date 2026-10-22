// Shared helpers for driving SignGuard + the Tide enclave in a headless browser.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const APP = "http://localhost:5173";
export const ACCOUNTS = fileURLToPath(new URL("../../demo-accounts.local.json", import.meta.url));

export async function launch() {
  return chromium.launch();
}

/** A browser profile for one person, signed in to SignGuard through Tide. */
export async function signIn(browser, who, { out, log = console.log } = {}) {
  const { tideUsername, password } = JSON.parse(readFileSync(ACCOUNTS, "utf8"))[who];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.grantPermissions(["local-network-access"]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/images\/(LOGO|BACKGROUND)/.test(m.text())) log(`[${who} console] ${m.text().slice(0, 240)}`); });
  ctx.on("page", (p) => {
    log(`[${who} popup] ${p.url().slice(0, 90)}`);
    p.on("console", (m) => { if (m.type() === "error") log(`[${who} popup console] ${m.text().slice(0, 240)}`); });
  });

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /sign in with/i }).click();
  await page.waitForURL(/tideprotocol\.com/, { timeout: 60000 });
  await page.locator("input#sign_in-input_name").first().waitFor({ timeout: 60000 });
  await page.fill("input#sign_in-input_name", tideUsername);
  await page.fill("input#sign_in-input_password", password);
  await page.locator("#sign_in-button").click();
  await page.waitForURL((u) => u.toString().startsWith(APP), { timeout: 120000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  if (out) await page.screenshot({ path: `${out}/${who}-signed-in.png`, fullPage: true });
  return { ctx, page };
}

/**
 * Click something in SignGuard that opens Tide's approval window, then approve every request in
 * it (Y) and submit, the way a person would. Returns the window's summary text.
 */
export async function approveInTide(ctx, trigger, { decision = "Y", out, name, who, log = console.log } = {}) {
  const before = new Set(ctx.pages());
  await trigger();
  const end = Date.now() + 120000;
  let popup = null;
  while (Date.now() < end && !popup) {
    for (const p of ctx.pages()) {
      if (before.has(p) || p.isClosed() || !p.url().includes("tideprotocol.com")) continue;
      // Wait until the enclave has fully loaded and styled itself: before that, every hidden view
      // (sign-in, approvals, errors) is visible at once.
      if ((await p.evaluate(() => document.readyState).catch(() => "")) !== "complete") continue;
      const styled = await p.evaluate(() => document.styleSheets.length > 0 && getComputedStyle(document.body).margin !== "8px").catch(() => false);
      if (!styled) continue;
      const signInShown = await p.getByText(/sign yourself in/i).first().isVisible().catch(() => false);
      if (!signInShown && await p.locator("#submitBtn").isVisible().catch(() => false)) { popup = p; break; }
      // Tide may ask the approver to confirm who they are first.
      const cont = p.locator(":is(button, [id$='-button'])", { hasText: /^continue$/i }).first();
      if (await p.getByText(/continue to sign in as/i).isVisible().catch(() => false) && await cont.isVisible().catch(() => false)) {
        log("    (Tide asked to confirm the sign-in: continuing)");
        await cont.click().catch(() => {});
      }
      const pw = p.locator("input[type=password]:visible").first();
      if (who && await pw.isVisible().catch(() => false)) {
        const { password } = JSON.parse(readFileSync(ACCOUNTS, "utf8"))[who];
        log("    (Tide asked for the password again: entering it)");
        await pw.fill(password);
        await p.keyboard.press("Enter");
      }
    }
    if (!popup) await new Promise((r) => setTimeout(r, 500));
  }
  if (!popup) throw new Error("Tide's approval window did not appear");
  const summary = (await popup.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
  if (out && name) await popup.screenshot({ path: `${out}/${name}.png` }).catch(() => {});
  const buttons = popup.getByRole("button", { name: decision, exact: true });
  for (let i = 0; i < (await buttons.count()); i++) await buttons.nth(i).click();
  await popup.locator("#submitBtn").click();
  await popup.waitForEvent("close", { timeout: 90000 }).catch(() => {});
  return summary;
}

export async function shot(page, out, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }).catch(() => {});
}

export const textOf = async (page) => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
