import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "@effect/vitest";

import {
  iosActivationClicks,
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
it("lets a Home Screen app icon be activated and taught by name", () => {
  expect(
    iosNodeInteraction({ hittable: true, kind: "element(44)" })
  ).toMatchObject({ covered: false, hittable: true });
});
it("refuses an element XCTest reports with an empty frame, such as an icon on another Home Screen page", () => {
  expect(
    iosNodeInteraction({
      kind: "element(44)",
      rect: { height: 0, width: 0, x: 0, y: 0 },
    }).covered
  ).toBe(true);
  expect(
    iosNodeInteraction({
      kind: "element(44)",
      rect: { height: 82, width: 64, x: 30, y: 300 },
    }).covered
  ).toBe(false);
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
  readonly ref?: string;
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
  expect(iosActivationPoint(controls.nodes, toggle)).toEqual({
    index: toggle.index,
    x: 46,
    y: 320,
  });
});
it("taps each half of a stretched stepper as its own button, through the button whose frame holds the drawn point", () => {
  const decrement = node("Quantity, Decrement");
  expect(iosActivationPoint(controls.nodes, decrement)).toEqual({
    index: decrement.index,
    x: 43,
    y: 463,
  });
  // The drawn increment lies in the decrement's half of the stretched row.
  expect(
    iosActivationPoint(controls.nodes, node("Quantity, Increment"))
  ).toEqual({ index: decrement.index, x: 89, y: 463 });
});
const generationSeven = (ref: string | undefined) =>
  ref === undefined ? "" : `@${ref}~s7`;
it("activates moved controls with a ref click at a point inside that ref's frame", () => {
  const target = generationSeven;
  const clicks = iosActivationClicks(controls.nodes, target);
  expect(Object.fromEntries(clicks)).toEqual({
    "@e12~s7": { point: { x: 46, y: 320 }, ref: "@e12~s7" },
    "@e19~s7": { point: { x: 43, y: 463 }, ref: "@e19~s7" },
    "@e20~s7": { point: { x: 89, y: 463 }, ref: "@e19~s7" },
  });
  for (const { point, ref } of clicks.values()) {
    const { rect } =
      controls.nodes.find((each) => target(each.ref) === ref) ?? {};
    expect(rect).toBeDefined();
    expect(point.x).toBeGreaterThanOrEqual(rect?.x ?? Infinity);
    expect(point.x).toBeLessThanOrEqual((rect?.x ?? 0) + (rect?.width ?? 0));
    expect(point.y).toBeGreaterThanOrEqual(rect?.y ?? Infinity);
    expect(point.y).toBeLessThanOrEqual((rect?.y ?? 0) + (rect?.height ?? 0));
  }
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
  expect(iosActivationPoint(nodes, first)).toEqual({ index: 2, x: 23, y: 16 });
  expect(iosActivationPoint(nodes, second)).toEqual({
    index: 2,
    x: 69,
    y: 16,
  });
});
/** An App Switcher card, as XCTest reports it on an iOS 26.5 iPhone 17. */
const card = (index: number, x: number) => ({
  index,
  parentIndex: 1,
  rect: { height: 590, width: 271, x, y: 133 },
  role: "other",
});
it("taps the uncovered part of an App Switcher card the newer card overlaps", () => {
  // Measured on an iOS 26.5 iPhone 17: the App Switcher's two full-screen
  // containers, the older app's card, and the newer card stacked over its
  // right side. Each card's centre lies on the other.
  const screen = { height: 874, width: 402, x: 0, y: 0 };
  const container = { index: 1, parentIndex: 0, rect: screen, role: "other" };
  const older = card(2, 10);
  const newer = card(3, 121);
  const switcher = [
    { index: 0, rect: screen, role: "other" },
    container,
    older,
    newer,
  ];
  const point = iosActivationPoint(switcher, older);
  expect(point?.x).toBeGreaterThan(10);
  expect(point?.x).toBeLessThan(121);
  // Either card is tapped where it alone lies, whichever is drawn on top.
  expect(iosActivationPoint(switcher, newer)?.x).toBeGreaterThan(281);
  // The containers are not peers of a card: they keep the frame-centre tap.
  expect(iosActivationPoint(switcher, container)).toBeNull();
});
