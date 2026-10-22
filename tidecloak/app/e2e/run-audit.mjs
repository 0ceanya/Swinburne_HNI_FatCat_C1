// The owner checks receipts and the audit log.
import { launch, shot, signIn, textOf } from "./lib.mjs";

const out = process.argv[2];
const browser = await launch();
const { page } = await signIn(browser, "owner", { out });
await page.goto("http://localhost:5173/documents", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
console.log("DOCUMENTS:", (await textOf(page)).slice(0, 700));
await shot(page, out, "owner-documents");
await page.getByRole("link", { name: /HD-0001/ }).click();
await page.waitForTimeout(3000);
console.log("\nE-INVOICE:", (await textOf(page)).slice(0, 1400));
await shot(page, out, "owner-einvoice-detail");
await page.goto("http://localhost:5173/audit", { waitUntil: "networkidle" });
await page.locator(".banner").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
console.log("\nAUDIT:", (await textOf(page)).slice(0, 1800));
await shot(page, out, "owner-audit");
await browser.close();
