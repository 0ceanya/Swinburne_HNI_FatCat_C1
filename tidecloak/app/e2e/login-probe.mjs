import { launch, signIn, shot, textOf } from "./lib.mjs";

const out = process.argv[2];
const who = process.argv[3] ?? "owner";
const browser = await launch();
try {
  const { page } = await signIn(browser, who, { out });
  await page.waitForTimeout(4000);
  console.log("URL:", page.url());
  console.log("TEXT:", (await textOf(page)).slice(0, 900));
  await shot(page, out, `${who}-home`);
} catch (e) {
  console.log("FAILED:", String(e.message).slice(0, 500));
} finally {
  await browser.close();
}
