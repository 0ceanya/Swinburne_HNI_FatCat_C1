// The accountant creates and submits a document. Prints the request id for the next steps.
import { launch, shot, signIn, textOf } from "./lib.mjs";

const [out, amount = "450000000", title = "Phiếu chi tạm ứng nhà cung cấp", type = "payment_voucher", counterparty = "Công ty TNHH Thương mại Phú An"] = process.argv.slice(2);
const browser = await launch();
const { page } = await signIn(browser, "accountant", { out });
await page.goto("http://localhost:5173/documents/new", { waitUntil: "networkidle" });
await page.locator("#d-title").waitFor();
await page.selectOption("#d-type", type);
await page.fill("#d-title", title);
await page.fill("#d-amount", amount);
await page.fill("#d-cp", counterparty);
await page.fill("#d-bank", "Vietcombank 0071000123456");
await page.fill("#d-desc", "Tạm ứng theo hợp đồng số 12/2026");
await page.waitForTimeout(500);
console.log("RULE PREVIEW:", (await page.locator("aside").innerText()).replace(/\s+/g, " ").slice(0, 200));
await shot(page, out, `create-${amount}-form`);
await page.getByRole("button", { name: /save and submit/i }).click();

// Wait until we leave the editor (success) or an error banner appears.
const end = Date.now() + 150000;
while (Date.now() < end) {
  if (!page.url().includes("/documents/new")) break;
  const err = await page.locator(".banner.tone-rejected").allInnerTexts();
  const busy = await page.locator('[role="status"]').allInnerTexts();
  if (err.some((t) => !/Development mode/.test(t))) { console.log("ERROR BANNER:", err.join(" | ")); break; }
  if (busy.length) console.log("  status:", busy.join(" | ").slice(0, 120));
  await page.waitForTimeout(2000);
}
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForTimeout(2500);
console.log("URL:", page.url());
console.log("PAGE:", (await textOf(page)).slice(0, 900));
await shot(page, out, `create-${amount}-after`);
await browser.close();
