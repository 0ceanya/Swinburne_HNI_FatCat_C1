// The requester finishes a fully approved request: approves in Tide, and the network seals or unlocks the key.
//   node run-finish.mjs <out> <who> [keyNameFilter]
// For an unlock, prints whether the secret appeared and its length, never the secret itself.
import { APP, approveInTide, launch, shot, signIn, textOf } from "./lib.mjs";

const [out, who, filter = ""] = process.argv.slice(2);
const browser = await launch();
const { ctx, page } = await signIn(browser, who, { out });
await page.goto(`${APP}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

let card = page.locator("section", { hasText: /ready for you to finish/i }).locator("a.card-link[href^='/requests/']");
if (filter) card = card.filter({ hasText: filter });
if (!(await card.count())) { console.log("nothing ready for", who, "to finish"); await browser.close(); process.exit(1); }
await card.first().click();
const finishButton = page.getByRole("button", { name: /approve in tide and (seal|unlock) it/i });
await finishButton.waitFor({ timeout: 30000 });
console.log(`${who} REQUEST:`, (await textOf(page)).slice(0, 700));

const summary = await approveInTide(ctx, () => finishButton.click(), { out, name: `${who}-tide-finish`, who });
console.log("\nTIDE WINDOW SHOWED:", summary.slice(0, 600));
// Then the network seals or decrypts (no window), and the server records it.
const end = Date.now() + 180000;
while (Date.now() < end) {
  const t = await textOf(page);
  if (/Unlocked for you|Sealed\. The key is in the vault/.test(t)) break;
  const err = await page.locator(".banner.tone-rejected").allInnerTexts();
  if (err.length) { console.log("ERROR:", err.join(" | ")); break; }
  await page.waitForTimeout(1500);
}
const secret = page.locator("[data-testid=secret]");
if (await secret.count()) {
  await page.getByRole("button", { name: /^show$/i }).click();
  console.log(`\nUNLOCKED: secret of ${(await secret.innerText()).length} characters shown in the browser`);
}
console.log(`\n${who} AFTER:`, (await textOf(page)).replace(/Unlocked for you.*?Hide now/s, "Unlocked for you [secret panel]").slice(0, 900));
await shot(page, out, `${who}-finished`);
await browser.close();
