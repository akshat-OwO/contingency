import { expect, it } from "@effect/vitest";

import { iosNodeInteraction } from "../../src/services/ios-observation.ts";

it("recognizes UIKit's semantic text fields without Android-only editable flags", () => {
  expect(iosNodeInteraction({ kind: "text-field" })).toMatchObject({
    covered: false,
    editable: true,
    hittable: true,
    password: false,
  });
});
it("classifies secure UIKit fields before a value can become a public name", () => {
  expect(iosNodeInteraction({ kind: "secure-text-field" }).password).toBe(true);
  expect(iosNodeInteraction({ type: "SecureTextField" }).password).toBe(true);
});
it("names an unmapped UIKit secure field as an editable secure-text-field", () => {
  expect(iosNodeInteraction({ type: "SecureTextField" })).toMatchObject({
    editable: true,
    hittable: true,
    password: true,
    role: "secure-text-field",
  });
});
it("never turns an application container or static text into an actionable pick", () => {
  expect(
    iosNodeInteraction({ hittable: true, kind: "application" }).hittable
  ).toBe(false);
  expect(iosNodeInteraction({ hittable: true, kind: "text" }).hittable).toBe(
    false
  );
});
it("keeps explicit covered, disabled, and non-hittable UIKit controls refused", () => {
  expect(
    iosNodeInteraction({ hittable: false, kind: "text-field" }).covered
  ).toBe(true);
  expect(iosNodeInteraction({ enabled: false, kind: "button" }).covered).toBe(
    true
  );
  expect(
    iosNodeInteraction({ interactionBlocked: "covered", kind: "button" })
      .covered
  ).toBe(true);
});
