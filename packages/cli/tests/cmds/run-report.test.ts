import { expect, test } from "vitest";

import {
  gateOverride,
  gateOverrideWarning,
} from "../../src/cmds/run-report.ts";

/**
 * How `--gate` and `--ignore-gate` resolve to the Gate a Run is held to.
 *
 * These are the fiddliest semantics the command carries — an empty list means
 * something different from an absent one — and the integration suite drives
 * the Runner's options rather than argv, so it never reaches them. The matrix
 * is small enough to pin exhaustively, which is the only way the distinction
 * stays true as the flags grow.
 */

test("no flag leaves the Flow's own Gate alone", () => {
  // `undefined`, not `[]`: an absent flag must not silently clear a Gate the
  // Flow declared.
  expect(gateOverride([], false)).toBeUndefined();
});

test("--gate replaces the Flow's Gate with the rules given", () => {
  expect(gateOverride(["image-alt"], false)).toEqual(["image-alt"]);
  expect(gateOverride(["image-alt", "label"], false)).toEqual([
    "image-alt",
    "label",
  ]);
});

test("--ignore-gate holds the Run to nothing", () => {
  // An empty list is a deliberate override, distinct from an absent one: it
  // relaxes the bar to nothing whatever the Flow declares.
  expect(gateOverride([], true)).toEqual([]);
});

test("--ignore-gate beats --gate when both are given", () => {
  expect(gateOverride(["image-alt"], true)).toEqual([]);
});

test("a conflicting pair of Gate flags is warned about, not resolved silently", () => {
  expect(gateOverrideWarning(["image-alt"], true)).toContain("--ignore-gate");
});

test("an unambiguous invocation warns nothing", () => {
  expect(gateOverrideWarning([], false)).toBeUndefined();
  expect(gateOverrideWarning(["image-alt"], false)).toBeUndefined();
  expect(gateOverrideWarning([], true)).toBeUndefined();
});
