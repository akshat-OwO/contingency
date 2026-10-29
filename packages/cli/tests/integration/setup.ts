import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";
import { afterAll, inject, vi } from "vitest";

// Resolve the installed browser before replacing HOME. MCP children must use
// this same cache rather than looking for a browser under their disposable home.
const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
const executableParts = chromium.executablePath().split(path.sep);
const revisionIndex = executableParts.findIndex((part) =>
  /^chromium-\d+$/u.test(part)
);
if (browserPath === undefined && revisionIndex === -1) {
  throw new Error("Could not locate the installed Playwright browser cache.");
}
const browserCache = (() => {
  if (browserPath === undefined) {
    return executableParts.slice(0, revisionIndex).join(path.sep);
  }
  return browserPath === "0" ? "0" : path.resolve(browserPath);
})();

// Each file runs in a fork. Its subprocesses inherit this private home, temp
// root and catalogs, so they cannot read user settings or scavenge another
// file's session resources. Fixture HTTP servers already bind port 0.
const root = mkdtempSync(path.join(inject("integrationRoot"), "file-"));
for (const name of ["home", "tmp", "catalog", "global-catalog"]) {
  mkdirSync(path.join(root, name));
}
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CONTINGENCY_")) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Vitest requires the value argument to remove an inherited setting.
    vi.stubEnv(name, undefined);
  }
}
for (const [name, value] of Object.entries({
  CONTINGENCY_CATALOG_ROOT: path.join(root, "catalog"),
  CONTINGENCY_GLOBAL_CATALOG_ROOT: path.join(root, "global-catalog"),
  HOME: path.join(root, "home"),
  PLAYWRIGHT_BROWSERS_PATH: browserCache,
  TEMP: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  TMPDIR: path.join(root, "tmp"),
  USERPROFILE: path.join(root, "home"),
})) {
  vi.stubEnv(name, value);
}

afterAll(() => {
  vi.unstubAllEnvs();
});
