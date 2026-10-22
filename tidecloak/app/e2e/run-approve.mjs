// One person opens the newest request waiting for them and approves (in Tide) or rejects it.
//   node run-approve.mjs <out> <who> approve|reject|view [amountFilter] [reason]
import { approveInTide, launch, shot, signIn, textOf } from "./lib.mjs";

const [out, who, action, amountFilter = "", reason = "Unknown payee, no contract on file"] = process.argv.slice(2);
const browser = await launch();
const { ctx, page } = await signIn(browser, who, { out });
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
console.log(`${who} INBOX:`, (await textOf(page)).slice(0, 500));
await shot(page, out, `${who}-inbox`);

let card = page.locator("a.card-link[href^='/approve/']");
if (amountFilter) card = card.filter({ hasText: amountFilter });
if (!(await card.count())) {
  // The initiator does not see their own request under "Waiting for you": go via their open requests.
  const mine = page.locator("a.card-link[href^='/documents/']").filter({ hasText: amountFilter || /₫/ }).first();
  if (await mine.count()) {
    await mine.click();
    await page.getByRole("link", { name: /open approve sheet/i }).click();
  } else { console.log("nothing to open"); await browser.close(); process.exit(1); }
} else await card.first().click();

await page.locator(".amount-hero").waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
console.log(`\n${who} APPROVE SHEET:`, (await textOf(page)).slice(0, 900));
await shot(page, out, `${who}-sheet-before`);

if (action === "approve") {
  const summary = await approveInTide(ctx, () => page.getByRole("button", { name: /^approve/i }).click(), { out, name: `${who}-tide-approval`, who });
  console.log("\nTIDE WINDOW SHOWED:", summary.slice(0, 700));
  // Wait for the flow to settle: recorded, and signed if this completed the quorum.
  await page.waitForFunction(() => !document.querySelector('[role="status"][aria-live]'), null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(3000);
} else if (action === "reject") {
  await page.getByRole("button", { name: /^reject$/i }).click();
  await page.fill("#reason", reason);
  await page.locator("form").getByRole("button", { name: /^reject$/i }).click();
  await page.waitForTimeout(3000);
}
console.log(`\n${who} AFTER:`, (await textOf(page)).slice(0, 900));
await shot(page, out, `${who}-sheet-after-${action}`);
await browser.close();
