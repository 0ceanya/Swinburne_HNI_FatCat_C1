// Explore Tide setup as the owner: what does the approval pop-up show, and what does the app report?
import { launch, signIn, shot, textOf } from "./lib.mjs";

const out = process.argv[2];
const browser = await launch();
const { ctx, page } = await signIn(browser, "owner", { out });
await page.goto("http://localhost:5173/setup", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await shot(page, out, "setup-1");
console.log("SETUP:", (await textOf(page)).slice(0, 700));

const popupPromise = ctx.waitForEvent("page", { timeout: 60000 }).catch(() => null);
await page.getByRole("button", { name: /approve in tide/i }).first().click();
const popup = await popupPromise;
if (popup) {
  for (let i = 1; i <= 6; i++) {
    await popup.waitForTimeout(4000);
    const t = (await popup.evaluate(() => document.body?.innerText ?? "").catch(() => "(closed)")).replace(/\s+/g, " ").slice(0, 600);
    const controls = await popup.$$eval("button, a, input, [id$='-button'], [role=button]", (els) => els.filter((e) => e.offsetParent !== null).map((e) =>
      `${e.tagName.toLowerCase()}#${e.id || "-"} "${(e.innerText || e.value || "").trim().slice(0, 30)}"`)).catch(() => []);
    console.log(`\nPOPUP t+${i * 4}s ${popup.isClosed() ? "(closed)" : popup.url().slice(0, 80)}\n text: ${t}\n controls: ${controls.join(" | ")}`);
    await popup.screenshot({ path: `${out}/setup-popup-${i}.png` }).catch(() => {});
    if (popup.isClosed()) break;
  }
} else console.log("no popup opened");
await page.waitForTimeout(3000);
console.log("\nAPP AFTER:", (await textOf(page)).slice(0, 700));
await shot(page, out, "setup-2");
await browser.close();
