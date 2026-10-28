import { expect, it } from "@effect/vitest";

import { sanitizeTeachingUrl } from "../../src/services/sensitive-data.ts";

it("preserves credentials, fragments, and query values", () => {
  const sanitized = new URL(
    sanitizeTeachingUrl(
      "https://alice:password@example.test/login?next=%2Fhome&access_token=secret&code=123#private"
    )
  );
  expect(sanitized.username).toBe("alice");
  expect(sanitized.password).toBe("password");
  expect(sanitized.hash).toBe("#private");
  expect(sanitized.searchParams.get("next")).toBe("/home");
  expect(sanitized.searchParams.get("access_token")).toBe("secret");
  expect(sanitized.searchParams.get("code")).toBe("123");
});
