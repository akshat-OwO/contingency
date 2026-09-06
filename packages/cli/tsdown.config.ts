import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    // Runtime dependencies stay external so npm installs them at their
    // declared ranges. The one exception is the workspace protocol package:
    // it is private and never published, so anything it exports has to be
    // inlined here or an installed `@contingencyhq/cli` would resolve an
    // import that does not exist on the registry.
    alwaysBundle: ["@contingency/protocol"],
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
