import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    neverBundle: true,
  },
  entry: "src/index.ts",
  fixedExtension: false,
  platform: "node",
  target: "node24",
});
