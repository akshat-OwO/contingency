import { expect, it } from "@effect/vitest";

import {
  isSensitiveField,
  sanitizeTeachingUrl,
} from "../../src/services/sensitive-data.ts";

it("recognizes credential and token metadata across field attributes", () => {
  expect(isSensitiveField({ name: "api-key" })).toBe(true);
  expect(isSensitiveField({ id: "access-token" })).toBe(true);
  expect(isSensitiveField({ ariaLabel: "One time code" })).toBe(true);
  expect(isSensitiveField({ autocomplete: "current-password" })).toBe(true);
  expect(isSensitiveField({ inputMode: "numeric", maxLength: 6 })).toBe(true);
  expect(isSensitiveField({ name: "display-name", type: "text" })).toBe(false);
});

it("sanitizes credentials, fragments, and sensitive query values", () => {
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
