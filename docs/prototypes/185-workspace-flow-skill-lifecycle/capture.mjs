// Throwaway prototype tooling for issue #185.
// Usage: node capture.mjs   (serve this directory on PORT first, default 4319)
// Needs playwright-core resolvable, for example:
//   npm i playwright-core --prefix /tmp/protoshot
//   NODE_PATH=/tmp/protoshot/node_modules node capture.mjs

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const PORT = process.env.PORT ?? "4319";
const PAGE_URL = `http://127.0.0.1:${PORT}/index.html`;
const OUT = new globalThis.URL("./shots/", import.meta.url).pathname;

const VIEWPORTS = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "mobile", width: 390 },
];

const browser = await chromium.launch();
const failures = [];
await rm(OUT, { force: true, recursive: true });
await mkdir(OUT, { recursive: true });

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage({
    viewport: { height: viewport.height, width: viewport.width },
  });
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  const states = await page.evaluate(async () => {
    const module = await import("./states.js");
    return { states: module.STATES.map((state) => state.id) };
  });

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (mode) =>
        document.documentElement.classList.toggle("dark", mode === "dark"),
      theme
    );
    for (const state of states.states) {
      await page.evaluate((id) => window.setPrototype(id), state);
      const names = await page.evaluate(() =>
        [...document.querySelectorAll("main button")].map(
          (button) =>
            button.getAttribute("aria-label") ?? button.textContent.trim()
        )
      );
      const distinct = new Set(names);
      if (distinct.size !== names.length) {
        failures.push(
          `${viewport.name}/${theme}/${state}: duplicate accessible names ${JSON.stringify(names)}`
        );
      }
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll("main button, main input, main select")]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.right > window.innerWidth + 1 || rect.left < -1;
          })
          .map(
            (element) =>
              element.getAttribute("aria-label") ?? element.textContent.trim()
          )
      );
      if (clipped.length > 0) {
        failures.push(
          `${viewport.name}/${theme}/${state}: controls clipped ${JSON.stringify(clipped)}`
        );
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      if (overflow > 1) {
        failures.push(
          `${viewport.name}/${theme}/${state}: page overflows by ${overflow}px`
        );
      }
      await page.screenshot({
        path: `${OUT}${viewport.name}-${theme}-${state}.png`,
      });
    }
  }
  await page.close();
}

await browser.close();
await writeFile(
  `${OUT}checks.txt`,
  failures.length === 0 ? "all checks passed\n" : `${failures.join("\n")}\n`
);
console.log(failures.length === 0 ? "all checks passed" : failures.join("\n"));
process.exit(failures.length === 0 ? 0 : 1);
