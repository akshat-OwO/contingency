import { defineConfig } from "vitest/config";

/** Launches a real browser per file, so it gets room and runs alone. */
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
