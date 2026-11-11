import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "@effect/vitest";

import {
  iosActivationPoint,
  iosNodeInteraction,
} from "../../src/services/ios-observation.ts";

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

it("normalizes the pinned SDK securetextfield kind", () => {
  expect(
    iosNodeInteraction({
      enabled: true,
      hittable: true,
      kind: "securetextfield",
      role: "UITextField",
      type: "SecureTextField",
    })
  ).toMatchObject({
    covered: false,
    editable: true,
    hittable: true,
    password: true,
    role: "secure-text-field",
  });
});

// The widget corpus stacks a UISwitch and a UIStepper in a vertical stack
// view, which stretches their frames to the row while UIKit draws them at the
// leading edge. Measured on an iOS 26.5 simulator, a tap at the frame center
// changes neither control; these points do.
interface CorpusNode {
  readonly index: number;
  readonly kind?: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly parentIndex?: number;
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}
const controls: { readonly nodes: readonly CorpusNode[] } = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "../fixtures/native-snapshots/ios/corpus-controls.json"
    ),
    "utf-8"
  )
);
const node = (label: string) => {
  const found = controls.nodes.find((candidate) => candidate.label === label);
  if (found === undefined) {
    throw new Error(`No ${label} node in corpus-controls`);
  }
  return found;
};

it("taps a stretched switch where UIKit draws it, not at the frame center", () => {
  const toggle = node("Notifications");
  expect(toggle.rect).toMatchObject({ width: 364, x: 20 });
  expect(iosActivationPoint(controls.nodes, toggle)).toEqual({ x: 46, y: 320 });
});
it("taps each half of a stretched stepper as its own button", () => {
  expect(
    iosActivationPoint(controls.nodes, node("Quantity, Decrement"))
  ).toEqual({ x: 43, y: 463 });
  expect(
    iosActivationPoint(controls.nodes, node("Quantity, Increment"))
  ).toEqual({ x: 89, y: 463 });
});
it("leaves frame-center taps for every other corpus control", () => {
  const moved = controls.nodes
    .filter((candidate) => iosActivationPoint(controls.nodes, candidate))
    .map((candidate) => candidate.label);
  expect(moved).toEqual([
    "Notifications",
    "Quantity, Decrement",
    "Quantity, Increment",
  ]);
});
it("keeps the frame center when a switch or stepper frame fits the control", () => {
  const rect = { height: 31, width: 51, x: 300, y: 100 };
  expect(iosActivationPoint([], { index: 0, kind: "switch", rect })).toBeNull();
  const stepper = {
    index: 1,
    kind: "stepper",
    rect: { height: 32, width: 94, x: 280, y: 200 },
  };
  const increment = {
    identifier: "Increment",
    index: 3,
    kind: "button",
    parentIndex: 1,
    rect: { height: 32, width: 47, x: 327, y: 200 },
  };
  expect(iosActivationPoint([stepper, increment], increment)).toBeNull();
});
it("orders unlabelled stepper buttons decrement first", () => {
  const stepper = {
    index: 1,
    kind: "stepper",
    rect: { height: 32, width: 300, x: 0, y: 0 },
  };
  const first = {
    index: 2,
    kind: "button",
    parentIndex: 1,
    rect: stepper.rect,
  };
  const second = {
    index: 3,
    kind: "button",
    parentIndex: 1,
    rect: stepper.rect,
  };
  const nodes = [stepper, first, second];
  expect(iosActivationPoint(nodes, first)).toEqual({ x: 23, y: 16 });
  expect(iosActivationPoint(nodes, second)).toEqual({ x: 69, y: 16 });
});
