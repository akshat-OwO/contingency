import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Rendered from the Settings schema; a test compares them byte for byte.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "packages/cli/config.schema.json",
    "packages/cli/docs/settings.md",
    // Written by the Scripted Agent recorder, so a re-recording diffs cleanly.
    "packages/cli/tests/fixtures/transcripts/**",
    // Vendored through skills-lock.json, whose hashes cover the files as published.
    ".agents/skills/**",
  ],
});
