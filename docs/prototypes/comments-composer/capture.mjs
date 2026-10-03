// Throwaway prototype tooling for the Teaching comments prototype.
// Usage: node capture.mjs   (serve this directory on PORT first, default 4320)
// Needs playwright-core resolvable, for example:
//   npm i playwright-core --prefix /tmp/protoshot
//   NODE_PATH=/tmp/protoshot/node_modules node capture.mjs

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const PORT = process.env.PORT ?? "4320";
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const OUT = new globalThis.URL("./shots/", import.meta.url).pathname;

const VARIANTS = ["composer", "dock", "rail", "spotlight"];
const VIEWPORTS = [
  { height: 860, name: "desktop", width: 1440 },
  { height: 760, name: "laptop", width: 1180 },
  { height: 844, name: "mobile", width: 390 },
];

/* Each scene drives the page through the scripted hooks in app.js. */
const SCENES = {
  "1-idle": async () => {},
  "2-history": async (page, variant) => {
    if (variant === "spotlight") {
      await page.keyboard.press("/");
    } else if (variant !== "rail") {
      await page.keyboard.press("h");
    }
  },
  "3-inspect": async (page) => {
    await page.evaluate(() => globalThis.prototype.hover("#place-order"));
  },
  "4-attached": async (page, variant) => {
    if (variant === "spotlight") {
      await page.evaluate(() =>
        globalThis.prototype.set({ spotlightOpen: true })
      );
    }
    await page.evaluate(() => globalThis.prototype.attach("#place-order"));
    await page.keyboard.type(
      "Wait for the total to update before placing the order"
    );
  },
};

const browser = await chromium.launch();
const failures = [];
await rm(OUT, { force: true, recursive: true });
await mkdir(OUT, { recursive: true });

for (const viewport of VIEWPORTS) {
  for (const theme of ["light", "dark"]) {
    if (theme === "dark" && viewport.name !== "desktop") {
      continue;
    }
    for (const variant of VARIANTS) {
      for (const [scene, run] of Object.entries(SCENES)) {
        const page = await browser.newPage({
          viewport: { height: viewport.height, width: viewport.width },
        });
        page.on("pageerror", (error) =>
          failures.push(
            `${viewport.name}/${variant}/${scene}: ${error.message}`
          )
        );
        await page.goto(`${PAGE_URL}#${variant}`, { waitUntil: "networkidle" });
        if (theme === "dark") {
          await page.evaluate(() =>
            document.documentElement.classList.add("dark")
          );
        }
        await run(page, variant);
        await page.waitForTimeout(350);
        const clipped = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              "#float button, #float textarea, #rail button"
            ),
          ]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.width > 0 &&
                (rect.right > window.innerWidth + 1 || rect.left < -1)
              );
            })
            .map(
              (element) =>
                element.getAttribute("aria-label") ?? element.textContent.trim()
            )
        );
        if (clipped.length > 0) {
          failures.push(
            `${viewport.name}/${theme}/${variant}/${scene}: clipped ${JSON.stringify(clipped)}`
          );
        }
        await page.screenshot({
          path: `${OUT}${viewport.name}-${theme}-${variant}-${scene}.png`,
        });
        await page.close();
      }
    }
  }
}

await browser.close();
await writeFile(
  `${OUT}checks.txt`,
  failures.length === 0 ? "all checks passed\n" : `${failures.join("\n")}\n`
);
console.log(failures.length === 0 ? "all checks passed" : failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
