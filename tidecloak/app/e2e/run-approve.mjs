// A board member opens the newest request waiting for them and approves (in Tide) or rejects it.
//   node run-approve.mjs <out> <who> approve|reject|view [keyNameFilter] [reason]
import { APP, approveInTide, launch, shot, signIn, textOf } from "./lib.mjs";

const [out, who, action = "view", filter = "", reason = "No ticket for this; ask again with a reason"] = process.argv.slice(2);
const browser = await launch();
const { ctx, page } = await signIn(browser, who, { out });
await page.goto(`${APP}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
console.log(`${who} INBOX:`, (await textOf(page)).slice(0, 600));
await shot(page, out, `${who}-inbox`);

let card = page.locator("section", { hasText: /waiting for your approval/i }).locator("a.card-link[href^='/requests/']");
if (filter) card = card.filter({ hasText: filter });
if (!(await card.count())) { console.log("nothing waiting for", who); await browser.close(); process.exit(1); }
await card.first().click();
await page.locator("h1", { hasText: /Unlock|Seal/ }).waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
console.log(`\n${who} REQUEST:`, (await textOf(page)).slice(0, 900));
await shot(page, out, `${who}-request-before`);

if (action === "approve") {
  const summary = await approveInTide(ctx, () => page.getByRole("button", { name: /^approve ✓/i }).click(), { out, name: `${who}-tide-approval`, who });
  console.log("\nTIDE WINDOW SHOWED:", summary.slice(0, 600));
  await page.waitForFunction(() => !document.querySelector('[role="status"][aria-live]'), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2000);
} else if (action === "reject") {
  await page.getByRole("button", { name: /^reject$/i }).click();
  await page.fill("#reason", reason);
  await page.locator("form").getByRole("button", { name: /^reject$/i }).click();
  await page.waitForTimeout(2500);
}
console.log(`\n${who} AFTER:`, (await textOf(page)).slice(0, 900));
await shot(page, out, `${who}-request-after-${action}`);
await browser.close();
