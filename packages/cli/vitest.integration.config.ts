import { defineConfig } from "vitest/config";

/** Two browser-owning forks fit a 4-vCPU / 16 GB CI runner. */
export default defineConfig({
  test: {
    fileParallelism: true,
    globalSetup: ["tests/integration/global-setup.ts"],
    hookTimeout: 180_000,
    include: ["tests/integration/**/*.test.ts"],
    maxWorkers: 2,
    pool: "forks",
    setupFiles: ["tests/integration/setup.ts"],
    testTimeout: 180_000,
  },
});
