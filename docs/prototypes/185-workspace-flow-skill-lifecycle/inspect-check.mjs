// Throwaway prototype tooling for issue #185. Drives the inspect and comment flow.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const OUT = new globalThis.URL("./shots/", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:4319/index.html", {
  waitUntil: "networkidle",
});
await page.evaluate(() => window.setPrototype("recording"));
await page.click('[data-action="toggle-inspect"]');
await page.hover("#quantity");
await page.screenshot({ path: `${OUT}inspect-hover.png` });
console.log("hover label:", await page.textContent("#hover-outline"));
await page.click("#quantity");
await page.screenshot({ path: `${OUT}inspect-selected.png` });
await page.fill(
  "#comment-text",
  "Quantity must come from the input, not a fixed 3."
);
await page.click('#comment-form button[type="submit"]');
await page.screenshot({ path: `${OUT}inspect-attached.png` });
console.log(
  "dock after attach:",
  (await page.textContent('[role="status"]')).replace(/\s+/g, " ").trim()
);
await page.evaluate(() => window.setPrototype("skill-drafted"));
console.log(
  "comment survives state change:",
  await page.evaluate(
    () => document.querySelectorAll("#inspect-layer > div").length
  )
);
await page.evaluate(() => window.setPrototype("recording"));
console.log(
  "pins back on recording:",
  await page.evaluate(
    () => document.querySelectorAll("#inspect-layer > div").length
  )
);
await browser.close();
