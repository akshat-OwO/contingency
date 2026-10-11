import { defineConfig } from "tsdown";

export default defineConfig({
  // Its UMD entry hides require calls inside a factory parameter.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  // open uses its adjacent helper on Linux when system xdg-open is absent.
  copy: [{ from: "node_modules/open/xdg-open", to: "dist/xdg-open" }],
  deps: {
    // These packages load files relative to their original module paths.
    // vendor-runtime copies their complete installed trees into dist.
    alwaysBundle: (id) =>
      !/^(?:playwright-core|lighthouse|puppeteer-core)(?:\/|$)/u.test(id),
    neverBundle: [/^(?:playwright-core|lighthouse|puppeteer-core)(?:\/|$)/u],
    onlyBundle: false,
    onlyImport: ["playwright-core", "lighthouse", "puppeteer-core"],
  },
  entry: "src/index.ts",
  env: {
    NODE_ENV: "production",
  },
  fixedExtension: false,
  platform: "node",
  target: "node24",
});
