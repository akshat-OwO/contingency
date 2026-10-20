import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Rendered from the Settings schema; a test compares them byte for byte.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "packages/cli/config.schema.json",
    "packages/cli/docs/settings.md",
  ],
});
