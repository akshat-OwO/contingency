import { defineConfig } from "vitest/config";

/**
 * The fast suite. Integration tests drive a real browser and are excluded, so
 * the ordinary test run stays quick enough to sit in a save cycle; run them
 * with `nub run test:integration`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
  },
});
