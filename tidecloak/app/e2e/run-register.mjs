// A board member adds a key to the vault: the secret is encrypted in their browser, then the board is asked to seal it.
//   node run-register.mjs <out> <who> <level 1-4> [name] [kind]
// The secret comes from $SECRET, or a random demo value. Only its length is printed.
import { randomBytes } from "node:crypto";
import { APP, launch, shot, signIn, textOf } from "./lib.mjs";

const [out, who = "owner", level = "4", name = "AWS root (demo)", kind = "cloud_root"] = process.argv.slice(2);
const secret = process.env.SECRET ?? `demo-${randomBytes(12).toString("hex")}`;
const browser = await launch();
const { page } = await signIn(browser, who, { out });
await page.goto(`${APP}/vault/new`, { waitUntil: "networkidle" });
await page.locator("#k-name").waitFor();
await page.selectOption("#k-kind", kind);
await page.selectOption("#k-level", level);
await page.fill("#k-name", name);
await page.fill("#k-provider", "Demo");
await page.fill("#k-desc", "Registered by the e2e script");
await page.fill("#k-secret", secret);
console.log("LEVEL HINT:", (await page.locator("#k-level + .hint").innerText()).trim());
await shot(page, out, `register-${who}-form`);
await page.getByRole("button", { name: /encrypt and ask the board/i }).click();

await page.waitForURL(/\/requests\//, { timeout: 120000 }).catch(async () => {
  console.log("DID NOT REACH THE REQUEST PAGE:", (await textOf(page)).slice(0, 600));
});
await page.waitForTimeout(2000);
console.log(`secret length ${secret.length}`);
console.log("URL:", page.url());
console.log("PAGE:", (await textOf(page)).slice(0, 900));
await shot(page, out, `register-${who}-request`);
await browser.close();
