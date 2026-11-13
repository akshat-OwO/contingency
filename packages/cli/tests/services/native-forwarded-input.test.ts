import type { NativeInput } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { androidControlPackets } from "../../src/services/android-control.ts";
import { iosHidCommands, iosKeyUsage } from "../../src/services/ios-hid.ts";
import {
  iosCapabilities,
  iosRuntimeError,
} from "../../src/services/ios-runtime.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import {
  adaptNativeAppRuntime,
  OBSERVATION_VALIDATION_MILLIS,
} from "../../src/services/native-app-runtime.ts";
import {
  describeGesture,
  gestureTarget,
  makeGestureRecognizer,
} from "../../src/services/native-forwarded-input.ts";
import {
  makeForwardedLane,
  SETTLE_MILLIS,
} from "../../src/services/native-forwarded-lane.ts";

const touch = (
  action: "down" | "move" | "up",
  x: number,
  y: number,
  at = 0
): NativeInput => ({ _tag: "touch", action, at, x, y });
const key = (
  name: string,
  options: { readonly code?: string; readonly modifiers?: number } = {}
): NativeInput[] => [
  {
    _tag: "key",
    action: "down",
    at: 0,
    code: options.code ?? "",
    key: name,
    modifiers: options.modifiers ?? 0,
  },
  {
    _tag: "key",
    action: "up",
    at: 0,
    code: options.code ?? "",
    key: name,
    modifiers: options.modifiers ?? 0,
  },
];
type KeyInput = Extract<NativeInput, { readonly _tag: "key" }>;
const keyDown = (
  name: string,
  options: { readonly code?: string; readonly modifiers?: number } = {}
): KeyInput => ({
  _tag: "key",
  action: "down",
  at: 0,
  code: options.code ?? "",
  key: name,
  modifiers: options.modifiers ?? 0,
});
const keyUp = (name: string): KeyInput => ({
  ...keyDown(name),
  action: "up",
});
const recognize = (inputs: readonly NativeInput[]) => {
  const recognizer = makeGestureRecognizer();
  const gestures = inputs.flatMap((input, index) =>
    recognizer.feed(input, index + 1)
  );
  return [...gestures, ...recognizer.flush()];
};

it("recognizes taps, long presses, and swipes from one finger", () => {
  expect(
    recognize([
      touch("down", 0.5, 0.5, 0),
      touch("move", 0.505, 0.5, 40),
      touch("up", 0.505, 0.5, 90),
      touch("down", 0.2, 0.2, 200),
      touch("up", 0.2, 0.2, 900),
      touch("down", 0.5, 0.8, 1000),
      touch("move", 0.5, 0.5, 1050),
      touch("up", 0.5, 0.3, 1100),
    ])
  ).toEqual([
    { gesture: { _tag: "tap", x: 0.5, y: 0.5 }, sequence: 1 },
    { gesture: { _tag: "long-press", x: 0.2, y: 0.2 }, sequence: 4 },
    {
      gesture: {
        _tag: "swipe",
        from: { x: 0.5, y: 0.8 },
        to: { x: 0.5, y: 0.3 },
      },
      sequence: 6,
    },
  ]);
});

it("coalesces typing into one fill and keeps keys and chords apart", () => {
  expect(
    recognize([
      ...key("Shift"),
      ...key("H"),
      ...key("i"),
      ...key("x"),
      ...key("Backspace"),
      ...key("!"),
      ...key("Enter"),
      ...key("a", { code: "KeyA", modifiers: 2 }),
      ...key("Backspace"),
    ]).map(({ gesture }) => gesture)
  ).toEqual([
    { _tag: "type", text: "Hi!" },
    { _tag: "key", key: "Enter", modifiers: 0 },
    { _tag: "key", key: "a", modifiers: 2 },
    { _tag: "key", key: "Backspace", modifiers: 0 },
  ]);
});

it("adds consecutive scrolls together and ends them at other input", () => {
  expect(
    recognize([
      { _tag: "scroll", at: 0, deltaX: 0, deltaY: 100, x: 0.5, y: 0.5 },
      { _tag: "scroll", at: 1, deltaX: 0, deltaY: 120, x: 0.5, y: 0.5 },
      touch("down", 0.1, 0.1),
      touch("up", 0.1, 0.1),
    ]).map(({ gesture }) => gesture)
  ).toEqual([
    { _tag: "scroll", deltaX: 0, deltaY: 220, x: 0.5, y: 0.5 },
    { _tag: "tap", x: 0.1, y: 0.1 },
  ]);
});

const node = (
  name: string,
  bounds: { x: number; y: number; width: number; height: number },
  covered = false
) => ({
  bounds,
  covered,
  editable: false,
  hittable: true,
  name,
  role: "button",
});
it("attributes gestures to the smallest named control and describes them", () => {
  const frame = {
    height: 200,
    nodes: [
      node("Card", { height: 100, width: 100, x: 0, y: 0 }),
      node("Buy", { height: 20, width: 40, x: 10, y: 10 }),
      node("Hidden", { height: 20, width: 20, x: 60, y: 60 }, true),
    ],
    width: 100,
  };
  const tap = { _tag: "tap", x: 0.2, y: 0.1 } as const;
  expect(gestureTarget(tap, frame)?.name).toBe("Buy");
  expect(gestureTarget({ _tag: "tap", x: 0.65, y: 0.33 }, frame)).toBe(
    undefined
  );
  expect(describeGesture(tap, { name: "Buy", role: "button" })).toEqual({
    description: "Activate button Buy",
    detail: null,
    kind: "activate",
  });
  expect(describeGesture({ _tag: "tap", x: 0.5, y: 0.25 })).toEqual({
    description: "Tap at 50% across, 25% down",
    detail: null,
    kind: "activate",
  });
  expect(
    describeGesture(
      { _tag: "type", text: "hello" },
      {
        name: "Email",
        role: "text-field",
      }
    )
  ).toEqual({
    description: "Enter text in text-field Email",
    detail: "hello",
    kind: "fill",
  });
  expect(
    describeGesture({
      _tag: "swipe",
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.5, y: 0.2 },
    }).description
  ).toBe("Swipe up at 50% across, 80% down");
  expect(describeGesture({ _tag: "key", key: "GoBack", modifiers: 0 })).toEqual(
    { description: "Go back", detail: null, kind: "back" }
  );
  expect(
    describeGesture({ _tag: "key", key: "a", modifiers: 2 }).description
  ).toBe("Press Control+a");
});

it("encodes Android touch, scroll, text, and key packets at the frame size", () => {
  const screen = { height: 2001, width: 1001 };
  const [down] = androidControlPackets(touch("down", 0.5, 0.25), screen);
  expect(down?.length).toBe(32);
  expect(down?.readUInt8(0)).toBe(2);
  expect(down?.readUInt8(1)).toBe(0);
  expect(down?.readInt32BE(10)).toBe(500);
  expect(down?.readInt32BE(14)).toBe(500);
  expect(down?.readUInt16BE(18)).toBe(1001);
  expect(down?.readUInt16BE(20)).toBe(2001);
  expect(down?.readUInt16BE(22)).toBe(0xff_ff);
  const [up] = androidControlPackets(touch("up", 0.5, 0.25), screen);
  expect(up?.readUInt8(1)).toBe(1);
  expect(up?.readUInt16BE(22)).toBe(0);

  const [scroll] = androidControlPackets(
    { _tag: "scroll", at: 0, deltaX: 0, deltaY: 100, x: 0, y: 1 },
    screen
  );
  expect(scroll?.length).toBe(21);
  expect(scroll?.readUInt8(0)).toBe(3);
  expect(scroll?.readInt32BE(5)).toBe(2000);
  // One notch down scrolls the content up: a negative sixteenth.
  expect(scroll?.readInt16BE(15)).toBe(-0x8_00);
});

it("encodes Android text, keys, and chords", () => {
  const screen = { height: 2001, width: 1001 };
  const [text] = androidControlPackets(keyDown("é"), screen);
  expect(text?.readUInt8(0)).toBe(1);
  expect(text?.subarray(5).toString("utf-8")).toBe("é");
  expect(androidControlPackets(keyUp("é"), screen)).toEqual([]);

  const [enter] = androidControlPackets(keyDown("Enter"), screen);
  expect(enter?.readUInt8(0)).toBe(0);
  expect(enter?.readInt32BE(2)).toBe(66);
  const [back] = androidControlPackets(keyDown("GoBack"), screen);
  expect(back?.readInt32BE(2)).toBe(4);
  const [selectAll] = androidControlPackets(
    keyDown("a", { code: "KeyA", modifiers: 2 }),
    screen
  );
  expect(selectAll?.readInt32BE(2)).toBe(29);
  expect(selectAll?.readInt32BE(10)).toBe(0x10_00);
  expect(androidControlPackets(keyDown("Shift"), screen)).toEqual([]);
});

it("translates Forwarded Input into iOS helper commands", () => {
  expect(iosKeyUsage("KeyA")).toBe(4);
  expect(iosKeyUsage("Digit1")).toBe(30);
  expect(iosKeyUsage("Digit0")).toBe(39);
  expect(iosKeyUsage("ShiftLeft")).toBe(225);
  expect(iosKeyUsage("F13")).toBe(undefined);
  expect(
    iosHidCommands([
      touch("down", 0.25, 0.5),
      touch("up", 0.25, 0.5),
      { _tag: "scroll", at: 0, deltaX: 0, deltaY: 200, x: 0.5, y: 0.5 },
      ...key("A", { code: "KeyA" }),
      ...key("GoBack"),
    ])
  ).toEqual([
    "touch down 0.25 0.5",
    "touch up 0.25 0.5",
    "scroll 0.5 0.5 0 -0.2",
    "key down 4",
    "key up 4",
  ]);
});

const laneNode = {
  bounds: { height: 10, width: 10, x: 0, y: 0 },
  covered: false,
  editable: true,
  hittable: true,
  name: "Email",
  role: "text-field",
};
interface LaneObservation {
  readonly id: string;
}
const makeTestLane = (latest: () => LaneObservation | null) => {
  const sent: NativeInput[][] = [];
  const focused: (string | undefined)[] = [];
  const lane = makeForwardedLane<LaneObservation, typeof laneNode, never>({
    focus: (target) => {
      focused.push(target?.name);
    },
    frame: () => ({ height: 10, nodes: [laneNode], width: 10 }),
    latest,
    send: (inputs) => Effect.sync(() => sent.push([...inputs])),
  });
  return { focused, lane, sent };
};

it.effect(
  "sends input first and attributes it against the latest observation",
  () =>
    Effect.gen(function* attributeForwardedInput() {
      const observation = { id: "one" };
      const { focused, lane, sent } = makeTestLane(() => observation);
      lane.observed(lane.observing());
      yield* lane.forward([touch("down", 0.5, 0.5), touch("up", 0.5, 0.5)]);
      yield* lane.forward([...key("o"), ...key("k")]);
      expect(sent).toHaveLength(2);
      expect(focused).toEqual(["Email"]);
      const [tap, typed] = lane.take();
      expect(tap?.gesture).toEqual({ _tag: "tap", x: 0.5, y: 0.5 });
      expect(tap?.target?.name).toBe("Email");
      expect(tap?.inferred).toBe(false);
      // The tap could have changed the screen before typing began.
      expect(typed?.gesture).toEqual({ _tag: "type", text: "ok" });
      expect(typed?.target?.name).toBe("Email");
      expect(typed?.inferred).toBe(true);
      expect(lane.take()).toEqual([]);
    })
);

it.effect("marks an observation that input overtook as stale", () =>
  Effect.gen(function* staleObservation() {
    const { lane } = makeTestLane(() => ({ id: "one" }));
    const started = lane.observing();
    yield* lane.forward([touch("down", 0.5, 0.5)]);
    expect(lane.current(started)).toBe(false);
    expect(lane.unobserved()).toBe(1);
    const next = lane.observing();
    expect(lane.current(next)).toBe(true);
    lane.observed(next);
    expect(lane.unobserved()).toBe(0);
  })
);

it.effect("settles once input is quiet and the finger is lifted", () =>
  Effect.scoped(
    Effect.gen(function* settleQuietInput() {
      const scope = yield* Effect.scope;
      const { lane } = makeTestLane(() => ({ id: "one" }));
      const settled = yield* Deferred.make<number>();
      let attempts = 0;
      const settle = Effect.sync(() => {
        attempts += 1;
        return attempts;
      }).pipe(
        Effect.tap((attempt) =>
          attempt === 2 ? Deferred.succeed(settled, attempt) : Effect.void
        ),
        // The first settling observation was overtaken; the second is current.
        Effect.map((attempt) => attempt === 2)
      );
      yield* lane.forward([touch("down", 0.5, 0.5)]);
      yield* lane.wake(scope, settle);
      // A held finger keeps the lane waiting, however long it is held.
      yield* TestClock.adjust(SETTLE_MILLIS * 10);
      expect(attempts).toBe(0);
      yield* lane.forward([touch("up", 0.5, 0.5)]);
      yield* lane.wake(scope, settle);
      yield* TestClock.adjust(SETTLE_MILLIS / 2);
      expect(attempts).toBe(0);
      const waiting = yield* Deferred.await(settled).pipe(Effect.forkScoped);
      yield* TestClock.adjust(SETTLE_MILLIS * 2);
      expect(yield* Fiber.join(waiting)).toBe(2);
    })
  )
);

it.effect(
  "validates observations on a cadence and when another app comes forward",
  () =>
    Effect.scoped(
      Effect.gen(function* validationCadence() {
        const scope = yield* Effect.scope;
        let validations = 0;
        let app = "dev.fixture";
        let generation = 0;
        const runtime = yield* adaptNativeAppRuntime({
          backend: {
            activate: () => Effect.void,
            capture: () =>
              Effect.sync(() => {
                generation += 1;
                return {
                  app,
                  id: `observation-${generation}`,
                  nodes: [],
                  platform: "ios" as const,
                  screenshot: {
                    capturedAt: "now",
                    encoding: "base64" as const,
                    format: "png" as const,
                    image: "pixels",
                  },
                };
              }),
            close: () => Effect.void,
            fill: () =>
              Effect.succeed({
                confirmation: "confirmed" as const,
                outcome: "entered" as const,
              }),
            recover: () => Effect.void,
            sessionId: "cadence",
            validate: () =>
              Effect.sync(() => {
                validations += 1;
              }),
          },
          capabilities: iosCapabilities,
          error: iosRuntimeError,
          foreground: (observation) => observation.app,
          policy: nativeAppActionPolicy(iosRuntimeError, false),
          startup: {
            device: { kind: "simulator" },
            platform: "ios",
            requiredCapabilities: [],
            scope,
            targetApp: "dev.fixture",
          },
        });
        yield* runtime.observe();
        yield* runtime.observe();
        expect(validations).toBe(1);
        app = "com.apple.Preferences";
        yield* runtime.observe();
        expect(validations).toBe(2);
        yield* runtime.observe();
        expect(validations).toBe(2);
        // it.effect provides TestClock, so this reaches the next check.
        yield* TestClock.adjust(OBSERVATION_VALIDATION_MILLIS);
        yield* runtime.observe();
        expect(validations).toBe(3);
      })
    )
);
