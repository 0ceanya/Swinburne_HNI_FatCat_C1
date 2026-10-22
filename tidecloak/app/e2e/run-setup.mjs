// As the owner (realm admin): approve every vault policy (1, 2 and 3 approvals) in Tide's window.
import { approveInTide, launch, shot, signIn, textOf } from "./lib.mjs";

const out = process.argv[2];
const browser = await launch();
const { ctx, page } = await signIn(browser, "owner", { out });
await page.goto("http://localhost:5173/setup", { waitUntil: "networkidle" });
await page.locator("button", { hasText: "Approve in Tide" }).first().waitFor({ timeout: 30000 });

for (let round = 1; round <= 6; round++) {
  const button = page.locator("button:not([disabled])", { hasText: "Approve in Tide" }).first();
  if (!(await button.count())) break;
  const row = (await button.locator("xpath=ancestor::tr|ancestor::section").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
  console.log(`\n--- approving: ${row}`);
  const summary = await approveInTide(ctx, () => button.click(), { out, name: `setup-approve-${round}`, who: "owner" });
  console.log("    Tide window showed:", summary.slice(0, 160));
  await page.locator('[role="status"]').filter({ hasText: /signed|stored|verified/i }).first().waitFor({ timeout: 120000 }).catch(() => {});
  const banner = await page.locator(".banner").allInnerTexts();
  console.log("    app says:", banner.join(" | ").replace(/\s+/g, " ").slice(0, 300));
  await page.waitForTimeout(1500);
}
await shot(page, out, "setup-done");
console.log("\nFINAL:", (await textOf(page)).slice(0, 1200));
await browser.close();
