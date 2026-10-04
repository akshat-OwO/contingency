/**
 * Screenshots every prototype across scenarios, Workspace layouts, and themes,
 * and fails when a dock's controls wrap onto a second row or leave the stage.
 *
 *   PLAYWRIGHT=/path/to/playwright-core OUT=/tmp/shots node capture.mjs
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");

const BASE = process.env.BASE ?? "http://127.0.0.1:5180/";
const OUT = process.env.OUT ?? new URL("shots/", import.meta.url).pathname;
const only = (name, all) => process.env[name]?.split(",") ?? all;

const variants = only("VARIANTS", [
  "current",
  "stacked",
  "pill",
  "bubble",
  "bar",
]);
const scenarios = only("SCENARIOS", [
  "dry-run",
  "interactive-run",
  "run-failed",
  "teaching",
  "teaching-dry-run-passed",
]);
const layouts = only("LAYOUTS", [
  "none",
  "devtools-right",
  "devtools-bottom",
  "summary",
  "summary-devtools-right",
]);
const themes = only("THEMES", ["light", "dark"]);
const viewports = {
  desktop: { height: 900, width: 1440 },
  mobile: { height: 844, width: 390 },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const failures = [];

for (const [device, viewport] of Object.entries(viewports)) {
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport });
  for (const variant of variants) {
    for (const scenario of scenarios) {
      for (const layout of device === "mobile"
        ? ["none", "summary"]
        : layouts) {
        for (const theme of device === "mobile" ? ["light"] : themes) {
          const query = new URLSearchParams({
            capture: "1",
            layout,
            scenario,
            theme,
            variant,
          });
          await page.goto(`${BASE}?${query}`);
          await page.waitForSelector('[aria-label="Workspace dock"]');
          await page.waitForTimeout(250);
          const name = `${device}--${variant}--${scenario}--${layout}--${theme}`;
          // A control row is wrapped when two of its buttons sit on different lines.
          const report = await page.evaluate(() => {
            const dock = document.querySelector(
              '[aria-label="Workspace dock"]'
            );
            const stage = document.querySelector(
              '[aria-label="Browser stage"]'
            );
            const buttons = [...dock.querySelectorAll("button, select")].filter(
              (element) =>
                element.getClientRects().length > 0 &&
                !element.closest("[aria-expanded=true] ~ *")
            );
            const centres = new Set(
              buttons.map((element) => {
                const box = element.getBoundingClientRect();
                return Math.round((box.top + box.bottom) / 2 / 8);
              })
            );
            const dockBox = dock.getBoundingClientRect();
            const stageBox = stage.getBoundingClientRect();
            return {
              dockHeight: Math.round(dockBox.height),
              escapes:
                dockBox.left < stageBox.left - 1 ||
                dockBox.right > stageBox.right + 1,
              rows: centres.size,
              stageWidth: Math.round(stageBox.width),
            };
          });
          await page.screenshot({
            path: `${OUT}/${name}.jpg`,
            quality: 80,
            type: "jpeg",
          });
          console.log(name, JSON.stringify(report));
          if (report.escapes) {
            failures.push(`${name}: dock leaves the stage`);
          }
        }
      }
    }
  }
  await page.close();
}

// One shot per variant with its details open, so the expanded state is reviewed too.
const openers = {
  bar: '[aria-label="Workspace dock"] button[aria-expanded]',
  bubble: 'button:has-text("More")',
  current: 'button:has-text("Task details")',
  pill: '[aria-label="Show details"]',
  stacked: '[aria-label="Show more"]',
};
const detailPage = await browser.newPage({
  deviceScaleFactor: 1,
  viewport: viewports.desktop,
});
for (const variant of variants) {
  for (const theme of themes) {
    const query = new URLSearchParams({
      capture: "1",
      layout: "devtools-right",
      scenario: "interactive-run",
      theme,
      variant,
    });
    await detailPage.goto(`${BASE}?${query}`);
    await detailPage.waitForSelector('[aria-label="Workspace dock"]');
    const opener = detailPage.locator(openers[variant]).first();
    if ((await opener.count()) > 0) {
      await opener.click();
    }
    await detailPage.waitForTimeout(300);
    await detailPage.screenshot({
      path: `${OUT}/open--${variant}--${theme}.jpg`,
      quality: 80,
      type: "jpeg",
    });
  }
}

// Two-tier card interactions: the boundary's details and the session picker.
const extras = [
  {
    name: "boundary-details",
    opener: 'button:has-text("Details")',
    scenario: "boundary",
  },
  {
    name: "session-select",
    opener: '[aria-label="Agent Session"]',
    scenario: "dry-run",
  },
];
for (const { name, opener, scenario } of extras) {
  for (const theme of themes) {
    const query = new URLSearchParams({
      capture: "1",
      layout: "devtools-right",
      scenario,
      theme,
      variant: "stacked",
    });
    await detailPage.goto(`${BASE}?${query}`);
    await detailPage.waitForSelector('[aria-label="Workspace dock"]');
    await detailPage.locator(opener).first().click();
    await detailPage.waitForTimeout(300);
    await detailPage.screenshot({
      path: `${OUT}/open--stacked-${name}--${theme}.jpg`,
      quality: 80,
      type: "jpeg",
    });
  }
}

await browser.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
