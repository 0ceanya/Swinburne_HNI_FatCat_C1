// The owner checks the vault and the audit log.
import { launch, shot, signIn, textOf } from "./lib.mjs";

const out = process.argv[2];
const browser = await launch();
const { page } = await signIn(browser, "owner", { out });
await page.goto("http://localhost:5173/vault", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
console.log("VAULT:", (await textOf(page)).slice(0, 900));
await shot(page, out, "owner-vault");
await page.goto("http://localhost:5173/audit", { waitUntil: "networkidle" });
await page.locator(".banner").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
console.log("\nAUDIT:", (await textOf(page)).slice(0, 1800));
await shot(page, out, "owner-audit");
await browser.close();
