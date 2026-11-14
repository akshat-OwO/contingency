import type { BrowserInput, NativeInput } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  probeBrowserInput,
  probeNativeInput,
} from "@/components/agent/first-response-probe";
import type {
  FirstResponseProbe,
  ProbeGesture,
} from "@/components/agent/first-response-probe";

const recordingProbe = () => {
  const gestures: ProbeGesture[] = [];
  const probe: FirstResponseProbe = {
    frame: () => {
      // Frames are not part of gesture classification.
    },
    input: (gesture) => {
      gestures.push(gesture);
    },
  };
  return { gestures, probe };
};

const touch = (
  action: "down" | "move" | "up",
  x: number,
  y: number
): NativeInput => ({ _tag: "touch", action, at: 0, x, y });

test("native drags start at the move that leaves a tap's travel", () => {
  const { gestures, probe } = recordingProbe();
  const hear = probeNativeInput(probe);
  hear(touch("down", 0.5, 0.5));
  hear(touch("move", 0.51, 0.5));
  expect(gestures).toEqual([]);
  hear(touch("move", 0.5, 0.45));
  expect(gestures).toEqual(["drag"]);
  // Later moves and the release belong to the same drag.
  hear(touch("move", 0.5, 0.3));
  hear(touch("up", 0.5, 0.3));
  expect(gestures).toEqual(["drag"]);
  // A press that barely moves is a tap, measured from its release.
  hear(touch("down", 0.2, 0.2));
  hear(touch("move", 0.21, 0.2));
  expect(gestures).toEqual(["drag"]);
  hear(touch("up", 0.21, 0.2));
  expect(gestures).toEqual(["drag", "tap"]);
});

const mouse = (
  eventType: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number
): BrowserInput => ({ eventType, type: "input_mouse", x, y });

test("browser drags are classified on the same terms", () => {
  const { gestures, probe } = recordingProbe();
  const hear = probeBrowserInput(probe);
  hear(mouse("mousePressed", 100, 100));
  hear(mouse("mouseMoved", 104, 100));
  expect(gestures).toEqual([]);
  hear(mouse("mouseMoved", 100, 120));
  hear(mouse("mouseMoved", 100, 160));
  hear(mouse("mouseReleased", 100, 160));
  expect(gestures).toEqual(["drag"]);
  hear(mouse("mousePressed", 50, 50));
  hear(mouse("mouseReleased", 52, 50));
  expect(gestures).toEqual(["drag", "tap"]);
});
