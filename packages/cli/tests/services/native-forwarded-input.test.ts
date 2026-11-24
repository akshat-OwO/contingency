import type { NativeInput } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { TestClock } from "effect/testing";

import {
  androidControlGesture,
  androidControlPackets,
} from "../../src/services/android-control.ts";
import {
  FailureReferences,
  lookupFailure,
  makeFailureReferenceStore,
} from "../../src/services/failure-reference.ts";
import {
  IOS_HID_READY_TIMEOUT_MILLIS,
  iosHidCommands,
  iosKeyUsage,
  IosHidUnavailableError,
  makeIosHid,
  makeIosHidWriter,
  MOVE_SPACING_MILLIS,
} from "../../src/services/ios-hid.ts";
import type { IosHidHost, IosHidProcess } from "../../src/services/ios-hid.ts";
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
import {
  makeWheelFinger,
  MIN_DRAG_FRACTION,
  REST_MOVES,
  WHEEL_RELEASE_MILLIS,
} from "../../src/services/wheel-finger.ts";

const touch = (
  action: "down" | "move" | "up",
  x: number,
  y: number,
  at = 0
): Extract<NativeInput, { readonly _tag: "touch" }> => ({
  _tag: "touch",
  action,
  at,
  x,
  y,
});
const wheel = (deltaY: number, y: number, deltaX = 0): NativeInput => ({
  _tag: "scroll",
  at: 0,
  deltaX,
  deltaY,
  x: 0.5,
  y,
});
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
  // Text typed into a password field stays out of the evidence.
  expect(
    describeGesture(
      { _tag: "type", text: "hunter2" },
      { name: "Password", password: true, role: "text-field" }
    )
  ).toEqual({
    description: "Enter text in text-field Password",
    detail: null,
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
  expect(describeGesture({ _tag: "key", key: "GoHome", modifiers: 0 })).toEqual(
    { description: "Go home", detail: null, kind: "home" }
  );
  expect(
    describeGesture({ _tag: "key", key: "AppSwitch", modifiers: 0 })
  ).toEqual({
    description: "Open the App Switcher",
    detail: null,
    kind: "app-switcher",
  });
  // The keyboard's Home key moves the text cursor; it is not the device's.
  expect(
    describeGesture({ _tag: "key", key: "Home", modifiers: 0 }).description
  ).toBe("Press Home");
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
  // The device's Home button and App Switcher, apart from the cursor's Home.
  const [home] = androidControlPackets(keyDown("GoHome"), screen);
  expect(home?.readInt32BE(2)).toBe(3);
  const [appSwitch] = androidControlPackets(keyDown("AppSwitch"), screen);
  expect(appSwitch?.readInt32BE(2)).toBe(187);
  const [cursorHome] = androidControlPackets(keyDown("Home"), screen);
  expect(cursorHome?.readInt32BE(2)).toBe(122);
  const [selectAll] = androidControlPackets(
    keyDown("a", { code: "KeyA", modifiers: 2 }),
    screen
  );
  expect(selectAll?.readInt32BE(2)).toBe(29);
  expect(selectAll?.readInt32BE(10)).toBe(0x10_00);
  expect(androidControlPackets(keyDown("Shift"), screen)).toEqual([]);
});

it("translates finger and key input into emulator stream gestures", () => {
  expect(androidControlGesture(touch("down", 0.5, 0.25))).toEqual({
    action: "down",
    type: "touch",
    x: 0.5,
    y: 0.25,
  });
  expect(androidControlGesture(keyDown("é"))).toEqual({
    text: "é",
    type: "text",
  });
  expect(androidControlGesture(keyUp("é"))).toBe(undefined);
  expect(
    androidControlGesture(keyDown("a", { code: "KeyA", modifiers: 2 }))
  ).toEqual({ action: "down", keycode: 29, metaState: 0x10_00, type: "key" });
  expect(androidControlGesture(keyDown("Shift"))).toBe(undefined);
});

it("drives a held finger from the wheel", () => {
  const finger = makeWheelFinger();
  // A wheel turned down drags the content up, from under the pointer.
  expect(finger.feed(wheel(100, 0.5))).toEqual([
    touch("down", 0.5, 0.5),
    touch("move", 0.5, 0.4),
  ]);
  expect(finger.holding()).toBe(true);
  // Each later notch moves the same finger; nothing waits for a swipe.
  expect(finger.feed(wheel(50, 0.5))).toEqual([touch("move", 0.5, 0.35)]);
  expect(finger.feed(wheel(-150, 0.5))).toEqual([touch("move", 0.5, 0.5)]);
  // Once the wheel is quiet it rests in place, so the lift does not fling,
  // then lifts.
  expect(finger.release(0)).toEqual([
    touch("move", 0.5025, 0.5),
    touch("move", 0.5, 0.5),
    touch("move", 0.5025, 0.5),
    touch("move", 0.5, 0.5),
    touch("up", 0.5, 0.5),
  ]);
  expect(finger.holding()).toBe(false);
  expect(finger.release(0)).toEqual([]);
});

it("never lands a small or edge wheel turn as a tap", () => {
  const finger = makeWheelFinger();
  // Trackpad-sized deltas wait until the first drag passes the touch slop.
  for (let step = 0; step < 29; step += 1) {
    expect(finger.feed(wheel(1, 0.5))).toEqual([]);
  }
  const [down, move] = finger.feed(wheel(1, 0.5));
  expect(down).toMatchObject({ action: "down", y: 0.5 });
  expect(move?._tag === "touch" && 0.5 - move.y).toBeCloseTo(MIN_DRAG_FRACTION);
  finger.release(0);
  // At the top edge the finger starts lower, so its drag stays on screen.
  expect(finger.feed(wheel(200, 0))).toEqual([
    touch("down", 0.5, 0.2),
    touch("move", 0.5, 0),
  ]);
  // Out of room, it lifts and strokes again from under the pointer.
  const restroke = finger.feed(wheel(100, 0));
  expect(restroke).toEqual([
    touch("up", 0.5, 0),
    touch("down", 0.5, 0.1),
    touch("move", 0.5, 0),
  ]);
  // A small turn that runs out of room lifts and waits to add up again.
  expect(finger.feed(wheel(20, 0))).toEqual([touch("up", 0.5, 0)]);
  // The waiting delta still counts toward the next stroke. A touch lifts a
  // held finger first and drops any partial wheel delta.
  finger.feed(wheel(100, 0.5));
  expect(finger.feed(touch("down", 0.25, 0.25))).toEqual([
    touch("up", 0.5, 0.38),
    touch("down", 0.25, 0.25),
  ]);
  finger.feed(touch("up", 0.25, 0.25));
  expect(finger.feed(wheel(20, 0.5))).toEqual([]);
  expect(finger.feed(wheel(0, 0.5))).toEqual([]);
  // Keys pass through and leave the finger down.
  finger.feed(wheel(100, 0.5));
  expect(finger.feed(keyDown("a"))).toEqual([keyDown("a")]);
  expect(finger.holding()).toBe(true);
});

it("translates finger and key input into iOS helper commands", () => {
  expect(iosKeyUsage("KeyA")).toBe(4);
  expect(iosKeyUsage("Digit1")).toBe(30);
  expect(iosKeyUsage("Digit0")).toBe(39);
  expect(iosKeyUsage("ShiftLeft")).toBe(225);
  expect(iosKeyUsage("F13")).toBe(undefined);
  expect(
    iosHidCommands([
      touch("down", 0.25, 0.5),
      touch("up", 0.25, 0.5),
      keyDown("A", { code: "KeyA" }),
      { ...keyDown("A", { code: "KeyA" }), action: "up" },
      keyDown("GoBack"),
    ])
  ).toEqual([
    "touch down 0.25 0.5",
    "touch up 0.25 0.5",
    "key down 4",
    "key up 4",
  ]);
});

it.effect(
  "spaces iOS drags, keeps the latest, and lifts the wheel's finger",
  () =>
    Effect.scoped(
      Effect.gen(function* pacedIosInput() {
        const scope = yield* Effect.scope;
        const writes: { readonly at: number; readonly lines: string }[] = [];
        const wrote = yield* Deferred.make<true>();
        const writer = makeIosHidWriter(
          (lines) =>
            Effect.gen(function* recordWrite() {
              writes.push({ at: yield* Clock.currentTimeMillis, lines });
              if (lines.startsWith("touch up")) {
                yield* Deferred.succeed(wrote, true);
              }
            }),
          scope
        );
        yield* TestClock.adjust(1000);
        yield* writer.forward([touch("down", 0.5, 0.5)]);
        // Moves inside the spacing wait, and only the latest one goes.
        yield* writer.forward([touch("move", 0.5, 0.45)]);
        yield* writer.forward([touch("move", 0.5, 0.4)]);
        expect(writes.map(({ lines }) => lines)).toEqual([
          "touch down 0.5 0.5\n",
        ]);
        yield* TestClock.adjust(MOVE_SPACING_MILLIS);
        expect(writes.map(({ lines }) => lines)).toEqual([
          "touch down 0.5 0.5\n",
          "touch move 0.5 0.4\n",
        ]);
        // A release follows any drag still waiting, which keeps its spacing.
        yield* writer.forward([touch("move", 0.5, 0.3)]);
        const released = yield* writer
          .forward([touch("up", 0.5, 0.3)])
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust(MOVE_SPACING_MILLIS);
        yield* Fiber.join(released);
        expect(writes.slice(-2)).toEqual([
          { at: 1000 + 2 * MOVE_SPACING_MILLIS, lines: "touch move 0.5 0.3\n" },
          { at: 1000 + 2 * MOVE_SPACING_MILLIS, lines: "touch up 0.5 0.3\n" },
        ]);
        yield* TestClock.adjust(MOVE_SPACING_MILLIS);
        expect(writes).toHaveLength(4);

        // The wheel holds a finger that lifts only after the wheel is quiet.
        writes.length = 0;
        yield* writer.forward([wheel(100, 0.5)]);
        yield* TestClock.adjust(WHEEL_RELEASE_MILLIS / 2);
        yield* writer.forward([wheel(100, 0.5)]);
        yield* TestClock.adjust(WHEEL_RELEASE_MILLIS / 2);
        expect(writer.holding()).toBe(true);
        expect(writes.map(({ lines }) => lines)).toEqual([
          "touch down 0.5 0.5\n",
          "touch move 0.5 0.4\n",
          "touch move 0.5 0.3\n",
        ]);
        const lifted = yield* Deferred.await(wrote).pipe(Effect.forkScoped);
        yield* TestClock.adjust(WHEEL_RELEASE_MILLIS);
        yield* Fiber.join(lifted);
        expect(writer.holding()).toBe(false);
        // Resting moves, then the lift, each a drag spacing after the last.
        const lift = writes.slice(-(REST_MOVES + 1));
        expect(lift.map(({ lines }) => lines)).toEqual([
          "touch move 0.5025 0.3\n",
          "touch move 0.5 0.3\n",
          "touch move 0.5025 0.3\n",
          "touch move 0.5 0.3\n",
          "touch up 0.5 0.3\n",
        ]);
        for (const [index, write] of lift.entries()) {
          if (index > 0) {
            expect(write.at - (lift[index - 1]?.at ?? 0)).toBe(
              MOVE_SPACING_MILLIS
            );
          }
        }
      })
    )
);

it.effect("keeps drag spacing when the wheel restrokes at the edge", () =>
  Effect.scoped(
    Effect.gen(function* restrokeAtEdge() {
      const scope = yield* Effect.scope;
      const writes: { readonly at: number; readonly lines: string }[] = [];
      const writer = makeIosHidWriter(
        (lines) =>
          Effect.gen(function* recordWrite() {
            writes.push({ at: yield* Clock.currentTimeMillis, lines });
          }),
        scope
      );
      const edge: NativeInput = {
        _tag: "scroll",
        at: 0,
        deltaX: 0,
        deltaY: 100,
        x: 0.5,
        y: 0,
      };
      yield* writer.forward([edge]);
      yield* TestClock.adjust(8);
      // The second turn runs out of room and lifts before the first stroke's
      // drag is due, so the lift waits for that drag instead.
      const second = yield* writer.forward([edge]).pipe(Effect.forkScoped);
      yield* TestClock.adjust(2 * MOVE_SPACING_MILLIS);
      yield* Fiber.join(second);
      expect(writes).toEqual([
        { at: 0, lines: "touch down 0.5 0.1\n" },
        { at: MOVE_SPACING_MILLIS, lines: "touch move 0.5 0\n" },
        {
          at: MOVE_SPACING_MILLIS,
          lines: "touch up 0.5 0\ntouch down 0.5 0.1\n",
        },
        { at: 2 * MOVE_SPACING_MILLIS, lines: "touch move 0.5 0\n" },
      ]);
    })
  )
);

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
          policy: nativeAppActionPolicy(iosRuntimeError, []),
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

it.effect(
  "forwards screenshot options to backend capture while keeping default screenshots on observe and recover",
  () =>
    Effect.scoped(
      Effect.gen(function* screenshotOptions() {
        const scope = yield* Effect.scope;
        const requested: (boolean | undefined)[] = [];
        let generation = 0;
        const runtime = yield* adaptNativeAppRuntime({
          backend: {
            activate: () => Effect.void,
            capture: (options) =>
              Effect.sync(() => {
                requested.push(options?.image);
                generation += 1;
                return {
                  frame: { height: 2424, width: 1080 },
                  id: `obs-${generation}`,
                  nodes: [],
                  platform: "android" as const,
                  screenshot: {
                    capturedAt: "now",
                    encoding: "base64" as const,
                    format: "png" as const,
                    image: options?.image === false ? "" : "pixels",
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
            sessionId: "screenshot-options",
            validate: () => Effect.void,
          },
          capabilities: iosCapabilities,
          error: iosRuntimeError,
          policy: nativeAppActionPolicy(iosRuntimeError, []),
          startup: {
            device: { kind: "simulator" },
            platform: "ios",
            requiredCapabilities: [],
            scope,
            targetApp: "dev.fixture",
          },
        });
        const initial = yield* runtime.observe();
        expect(initial.screenshot.image).toBe("pixels");
        const skipped = yield* runtime.observe({ image: false });
        expect(skipped.screenshot.image).toBe("");
        expect(skipped.frame).toEqual({ height: 2424, width: 1080 });
        const explicit = yield* runtime.observe({ image: true });
        expect(explicit.screenshot.image).toBe("pixels");
        // Pause and recover to prove recover() captures with default screenshots.
        yield* Effect.flip(
          runtime.dispatch("stale-observation", {
            target: "missing",
            type: "activate",
          })
        );
        const recovered = yield* runtime.recover();
        expect(recovered.screenshot.image).toBe("pixels");
        expect(requested).toEqual([undefined, false, true, undefined]);
      })
    )
);

it.effect(
  "discards in-flight blocked sends and held touches across discard()",
  () =>
    Effect.gen(function* discardRaces() {
      const sendEntered = yield* Deferred.make<true>();
      const releaseSend = yield* Deferred.make<true>();
      let blockNext = false;
      const lane = makeForwardedLane<LaneObservation, typeof laneNode, never>({
        focus: () => {},
        frame: () => ({ height: 10, nodes: [laneNode], width: 10 }),
        latest: () => ({ id: "one" }),
        send: () =>
          Effect.gen(function* send() {
            if (blockNext) {
              blockNext = false;
              yield* Deferred.succeed(sendEntered, true);
              yield* Deferred.await(releaseSend);
            }
          }),
      });
      // 1. A held touch before discard() must not complete as a tap after discard().
      yield* lane.forward([touch("down", 0.5, 0.5)]);
      lane.discard();
      yield* lane.forward([touch("up", 0.5, 0.5)]);
      expect(lane.take()).toEqual([]);

      // 2. A forward() blocked in send() when discard() runs must not enqueue a gesture once send() finishes.
      blockNext = true;
      const inFlight = yield* lane
        .forward([touch("down", 0.5, 0.5), touch("up", 0.5, 0.5)])
        .pipe(Effect.forkChild);
      yield* Deferred.await(sendEntered);
      const beforeRelease = lane.observing();
      lane.discard();
      yield* Deferred.succeed(releaseSend, true);
      yield* Fiber.join(inFlight);
      // Stale-observation tracking still notices the physical input reached the device.
      expect(lane.current(beforeRelease)).toBe(false);
      expect(lane.take()).toEqual([]);
    })
);

const fakeHidProcess = (options: { readonly exitOnSigterm?: boolean } = {}) => {
  const exitOnSigterm = options.exitOnSigterm ?? true;
  const written: string[] = [];
  const dataListeners = new Set<(chunk: Buffer) => void>();
  const closeListeners = new Set<() => void>();
  const buffered: Buffer[] = [];
  const signals: NodeJS.Signals[] = [];
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const emitClose = () => {
    for (const listener of closeListeners) {
      closeListeners.delete(listener);
      listener();
    }
  };
  const finishExit = () => {
    if (exitCode === null && signalCode === null) {
      exitCode = 0;
      emitClose();
    }
  };
  const killBySignal = (
    signal: NodeJS.Signals,
    { close = true }: { readonly close?: boolean } = {}
  ) => {
    if (exitCode === null && signalCode === null) {
      signalCode = signal;
      if (close) {
        emitClose();
      }
    }
  };
  const child: IosHidProcess = {
    get exitCode() {
      return exitCode;
    },
    kill: (signal) => {
      signals.push(signal);
      if (exitOnSigterm || signal === "SIGKILL") {
        finishExit();
      }
      return true;
    },
    once: (event, listener) => {
      if (event === "close") {
        closeListeners.add(() => listener(exitCode, signalCode));
      }
    },
    get signalCode() {
      return signalCode;
    },
    stderr: { on: () => {} },
    stdin: {
      end: () => {},
      on: () => {},
      write: (chunk, done) => {
        if (exitCode !== null || signalCode !== null) {
          done(new Error("EPIPE"));
          return;
        }
        written.push(chunk);
        done(null);
      },
    },
    stdout: {
      off: (_event, listener) => {
        dataListeners.delete(listener);
      },
      on: (_event, listener) => {
        dataListeners.add(listener);
        while (buffered.length > 0) {
          const chunk = buffered.shift();
          if (chunk !== undefined) {
            listener(chunk);
          }
        }
      },
      resume: () => {},
    },
  };
  return {
    child,
    finishExit,
    isKilled: () => signals.length > 0,
    killBySignal,
    ready: () => {
      const chunk = Buffer.from("ready 402 874\n");
      if (dataListeners.size === 0) {
        buffered.push(chunk);
        return;
      }
      for (const listener of dataListeners) {
        listener(chunk);
      }
    },
    signals,
    written,
  };
};

it.effect(
  "pre-warms the iOS HID helper once across concurrent warm and forward calls and cleans up on scope close",
  () =>
    Effect.gen(function* warmIosHid() {
      const scope = yield* Scope.make();
      const spawned = yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const processes: ReturnType<typeof fakeHidProcess>[] = [];
      const host: IosHidHost = {
        command: () =>
          Effect.succeed("/Applications/Xcode.app/Contents/Developer"),
        helper: () => Effect.succeed("/tmp/hid"),
        spawn: () => {
          const fake = fakeHidProcess();
          processes.push(fake);
          Effect.runSync(Deferred.succeed(spawned, fake));
          return fake.child;
        },
      };
      const hid = yield* makeIosHid(() => "SIM-UDID", scope, host);
      yield* hid.warm?.() ?? Effect.void;
      const first = yield* Deferred.await(spawned);
      // Forward arriving while warm() is still awaiting "ready" shares the same startup.
      const forwarded = yield* hid
        .forward([touch("down", 0.5, 0.5)])
        .pipe(Effect.forkChild);
      first.ready();
      yield* Fiber.join(forwarded);
      expect(processes).toHaveLength(1);
      expect(first.written).toEqual(["touch down 0.5 0.5\n"]);
      // Subsequent input reuses the running helper without spawning again.
      yield* hid.forward([touch("up", 0.5, 0.5)]);
      expect(processes).toHaveLength(1);
      expect(first.written).toEqual([
        "touch down 0.5 0.5\n",
        "touch up 0.5 0.5\n",
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(first.isKilled()).toBe(true);
    })
);

it.effect(
  "names a Failure Reference when the iOS HID helper dies before it is ready",
  () =>
    Effect.gen(function* helperDiesEarly() {
      const scope = yield* Scope.make();
      const spawned = yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const host: IosHidHost = {
        command: () =>
          Effect.succeed("/Applications/Xcode.app/Contents/Developer"),
        helper: () => Effect.succeed("/tmp/hid"),
        spawn: () => {
          const fake = fakeHidProcess();
          Effect.runSync(Deferred.succeed(spawned, fake));
          return fake.child;
        },
      };
      const hid = yield* makeIosHid(() => "SIM-UDID", scope, host);
      const forwarded = yield* hid
        .forward([touch("down", 0.5, 0.5)])
        .pipe(Effect.flip, Effect.forkChild);
      // The helper crashes on its own, before its ready line.
      (yield* Deferred.await(spawned)).killBySignal("SIGSEGV");
      const failure = yield* Fiber.join(forwarded);
      expect(failure).toBeInstanceOf(IosHidUnavailableError);
      expect(failure.message).toBe(
        "The simulator input helper is unavailable. Nothing was sent."
      );
      const reference =
        failure instanceof IosHidUnavailableError
          ? failure.failureReference
          : "";
      const cause = yield* lookupFailure(reference ?? "");
      expect(Option.isSome(cause)).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

it.effect(
  "keeps ownership of an in-flight warmed iOS HID helper until it actually exits on scope close",
  () =>
    Effect.gen(function* cleanupWarmingHelper() {
      const scope = yield* Scope.make();
      const spawned = yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const host: IosHidHost = {
        command: () =>
          Effect.succeed("/Applications/Xcode.app/Contents/Developer"),
        helper: () => Effect.succeed("/tmp/hid"),
        spawn: () => {
          const fake = fakeHidProcess({ exitOnSigterm: false });
          Effect.runSync(Deferred.succeed(spawned, fake));
          return fake.child;
        },
      };
      const hid = yield* makeIosHid(() => "SIM-UDID", scope, host);
      yield* hid.warm?.() ?? Effect.void;
      const pending = yield* Deferred.await(spawned);
      // Close runs while the helper ignores SIGTERM; scope close must wait for exit.
      let closed = false;
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() => Effect.sync(() => (closed = true))),
        Effect.forkChild
      );
      yield* Effect.yieldNow;
      expect(pending.signals).toContain("SIGTERM");
      expect(closed).toBe(false);
      pending.finishExit();
      yield* Fiber.join(closing);
      expect(closed).toBe(true);
    })
);

it.effect(
  "replaces a pre-warmed iOS HID helper killed by a signal instead of reusing it",
  () =>
    Effect.gen(function* replaceSignalKilledHelper() {
      const scope = yield* Scope.make();
      const spawned: ReturnType<typeof fakeHidProcess>[] = [];
      const firstSpawned =
        yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const secondSpawned =
        yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const host: IosHidHost = {
        command: () =>
          Effect.succeed("/Applications/Xcode.app/Contents/Developer"),
        helper: () => Effect.succeed("/tmp/hid"),
        spawn: () => {
          const fake = fakeHidProcess();
          spawned.push(fake);
          if (spawned.length === 1) {
            Effect.runSync(Deferred.succeed(firstSpawned, fake));
          } else if (spawned.length === 2) {
            Effect.runSync(Deferred.succeed(secondSpawned, fake));
          }
          return fake.child;
        },
      };
      const hid = yield* makeIosHid(() => "SIM-UDID", scope, host);
      yield* hid.warm?.() ?? Effect.void;
      const first = yield* Deferred.await(firstSpawned);
      first.ready();
      yield* Effect.yieldNow;
      // Helper dies from a signal (exitCode === null, signalCode === "SIGKILL").
      first.killBySignal("SIGKILL", { close: false });
      const forwarded = yield* hid
        .forward([touch("down", 0.5, 0.5)])
        .pipe(Effect.forkChild);
      const second = yield* Deferred.await(secondSpawned);
      second.ready();
      yield* Fiber.join(forwarded);
      expect(spawned).toHaveLength(2);
      expect(first.written).toEqual([]);
      expect(second.written).toEqual(["touch down 0.5 0.5\n"]);
      yield* Scope.close(scope, Exit.void);
    })
);

it.effect(
  "times out a stalled pre-warm iOS HID helper, retires it, and lets later input retry",
  () =>
    Effect.gen(function* timeoutStalledWarmHelper() {
      const scope = yield* Scope.make();
      const spawned: ReturnType<typeof fakeHidProcess>[] = [];
      const firstSpawned =
        yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const secondSpawned =
        yield* Deferred.make<ReturnType<typeof fakeHidProcess>>();
      const host: IosHidHost = {
        command: () =>
          Effect.succeed("/Applications/Xcode.app/Contents/Developer"),
        helper: () => Effect.succeed("/tmp/hid"),
        spawn: () => {
          const fake = fakeHidProcess();
          spawned.push(fake);
          if (spawned.length === 1) {
            Effect.runSync(Deferred.succeed(firstSpawned, fake));
          } else if (spawned.length === 2) {
            Effect.runSync(Deferred.succeed(secondSpawned, fake));
          }
          return fake.child;
        },
      };
      const hid = yield* makeIosHid(() => "SIM-UDID", scope, host);
      yield* hid.warm?.() ?? Effect.void;
      const stalled = yield* Deferred.await(firstSpawned);
      // A caller interrupts its own forward while warm-up is stalled on ready.
      const canceled = yield* hid
        .forward([touch("down", 0.1, 0.1)])
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(canceled);
      // Advancing past the ready timeout retires the stalled helper and frees startLock.
      yield* TestClock.adjust(IOS_HID_READY_TIMEOUT_MILLIS);
      expect(stalled.signals).toContain("SIGTERM");
      // A subsequent forward spawns a fresh helper and succeeds.
      const retry = yield* hid
        .forward([touch("down", 0.5, 0.5)])
        .pipe(Effect.forkChild);
      const replacement = yield* Deferred.await(secondSpawned);
      replacement.ready();
      yield* Fiber.join(retry);
      expect(spawned).toHaveLength(2);
      expect(replacement.written).toEqual(["touch down 0.5 0.5\n"]);
      yield* Scope.close(scope, Exit.void);
    })
);
