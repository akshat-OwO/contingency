import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    neverBundle: true,
  },
  entry: "src/index.ts",
  env: {
    NODE_ENV: "production",
  },
  fixedExtension: false,
  platform: "node",
  target: "node24",
});
