import { expect, it } from "@effect/vitest";

import {
  LIGHTHOUSE_FCP_WAIT_MS,
  LIGHTHOUSE_LOAD_WAIT_MS,
  LIGHTHOUSE_PROCESSING_ALLOWANCE_MS,
  SCAN_GUARD_MS,
  SCAN_RELOAD_COMMIT_WAIT_MS,
} from "../../src/services/scan-budgets.ts";

it("leaves processing time between Lighthouse page waits and the scan hang guard", () => {
  expect(LIGHTHOUSE_PROCESSING_ALLOWANCE_MS).toBeGreaterThanOrEqual(20_000);
  expect(LIGHTHOUSE_FCP_WAIT_MS).toBeLessThanOrEqual(LIGHTHOUSE_LOAD_WAIT_MS);
  expect(
    LIGHTHOUSE_LOAD_WAIT_MS + LIGHTHOUSE_PROCESSING_ALLOWANCE_MS
  ).toBeLessThan(SCAN_GUARD_MS);
  expect(SCAN_RELOAD_COMMIT_WAIT_MS).toBeLessThan(SCAN_GUARD_MS);
});
