import { expect, it } from "@effect/vitest";

import { sanitizeTeachingUrl } from "../../src/services/sensitive-data.ts";

it("removes URL credentials and tokens while preserving ordinary query values", () => {
  const sanitized = new URL(
    sanitizeTeachingUrl(
      "https://alice:password@example.test/login?next=%2Fhome&access_token=secret&code=123#private"
    )
  );
  expect(sanitized.username).toBe("");
  expect(sanitized.password).toBe("");
  expect(sanitized.hash).toBe("");
  expect(sanitized.searchParams.get("next")).toBe("/home");
  expect(sanitized.searchParams.get("access_token")).toBe("[sensitive]");
  expect(sanitized.searchParams.get("code")).toBe("[sensitive]");
});
