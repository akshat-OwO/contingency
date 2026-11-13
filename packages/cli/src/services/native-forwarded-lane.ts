import type { NativeInput } from "@contingency/protocol";
import { Clock, Effect, Semaphore } from "effect";
import type { Scope } from "effect";

import {
  gestureTarget,
  makeGestureRecognizer,
} from "./native-forwarded-input.ts";
import type {
  ForwardedGesture,
  RecognizedGesture,
} from "./native-forwarded-input.ts";

/** How long the user's input stays quiet before the lane observes its result. */
export const SETTLE_MILLIS = 600;

interface LaneNode {
  readonly name: string;
  readonly role: string;
  readonly editable: boolean;
  readonly hittable: boolean;
  readonly covered: boolean;
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** A gesture the device received, waiting for the observation that shows its result. */
export interface PendingGesture<Observation, Node> {
  readonly gesture: ForwardedGesture;
  /** The latest observation when the gesture completed, if there was one. */
  readonly before: Observation | null;
  readonly target: Node | undefined;
  /** The target was read from an observation older than an earlier input. */
  readonly inferred: boolean;
}

/**
 * One session's Forwarded Input. Input goes to the device first and in order;
 * it never waits on an observation. Attribution happens afterwards, against
 * the latest observation, and an observation that input overtook is stale.
 */
export const makeForwardedLane = <
  Observation,
  Node extends LaneNode,
  E,
>(input: {
  /** The latest observation the session accepted. */
  readonly latest: () => Observation | null;
  readonly frame: (observation: Observation) => {
    readonly nodes: readonly Node[];
    readonly width: number;
    readonly height: number;
  };
  readonly send: (inputs: readonly NativeInput[]) => Effect.Effect<void, E>;
  /** A tap chose a field to type into, or left every field. */
  readonly focus: (
    target: Node | undefined,
    observation: Observation | null
  ) => void;
}) => {
  const recognizer = makeGestureRecognizer();
  const order = Semaphore.makeUnsafe(1);
  let sequence = 0;
  /** The sequence when the latest accepted observation began. */
  let observedSequence = -1;
  let lastInputAt = 0;
  let pending: PendingGesture<Observation, Node>[] = [];
  let focused: Node | undefined;
  let settling = false;
  /** Input arrived since the settling observation began. */
  let dirty = false;

  const attribute = ({ gesture, sequence: started }: RecognizedGesture) => {
    const before = input.latest();
    let target: Node | undefined;
    if (gesture._tag === "type") {
      target = focused;
    } else if (before !== null) {
      target = gestureTarget(gesture, input.frame(before));
    }
    if (gesture._tag === "tap" || gesture._tag === "long-press") {
      focused = target?.editable === true ? target : undefined;
      input.focus(focused, before);
    }
    pending.push({
      before,
      gesture,
      // Fresh only when every earlier input reached the device before the
      // observation began, so none of them could have changed what it shows.
      inferred: before === null || observedSequence < started - 1,
      target,
    });
  };

  return {
    /**
     * Whether an observation that began at `started` is still current. One
     * that input overtook is stale and must not be accepted as evidence.
     */
    current: (started: number) => sequence === started,
    /** Forgets gestures nobody will record, such as setup before Start. */
    discard: () => {
      recognizer.flush();
      pending = [];
    },
    /** Sends input to the device, then records the gestures it completed. */
    forward: (inputs: readonly NativeInput[]) =>
      order.withPermits(1)(
        Effect.gen(function* forwardInput() {
          yield* input.send(inputs);
          lastInputAt = yield* Clock.currentTimeMillis;
          dirty = true;
          for (const value of inputs) {
            sequence += 1;
            for (const recognized of recognizer.feed(value, sequence)) {
              attribute(recognized);
            }
          }
        })
      ),
    /**
     * Marks an observation that began at `started` as the latest one. Take
     * the gestures waiting on it first, so typing and scrolling in progress
     * are attributed to the screen they began on.
     */
    observed: (started: number) => {
      observedSequence = started;
    },
    /** The input count to stamp on an observation as it begins. */
    observing: () => sequence,
    /**
     * The gestures waiting for an observation of their result, oldest first.
     * Typing and scrolling in progress complete now.
     */
    take: () => {
      for (const recognized of recognizer.flush()) {
        attribute(recognized);
      }
      const taken = pending;
      pending = [];
      return taken;
    },
    /** Inputs sent since the latest accepted observation began. */
    unobserved: () => sequence - Math.max(observedSequence, 0),
    /**
     * Observes once the user's input is quiet and no touch is held, until an
     * observation is current. `settle` runs one observation and says whether
     * it was current; it owns its own failures.
     */
    wake: (
      scope: Scope.Scope,
      settle: Effect.Effect<boolean>
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (settling) {
          return Effect.void;
        }
        settling = true;
        return Effect.gen(function* settleForwardedInput() {
          for (;;) {
            const now = yield* Clock.currentTimeMillis;
            const quiet = now - lastInputAt;
            if (quiet < SETTLE_MILLIS || recognizer.holding()) {
              yield* Effect.sleep(Math.max(SETTLE_MILLIS - quiet, 50));
              continue;
            }
            dirty = false;
            const done = yield* settle;
            // Checked and cleared in one step, so input that arrives later
            // always finds the lane idle and wakes it again.
            if (done && !dirty) {
              settling = false;
              return;
            }
          }
        }).pipe(
          Effect.ensuring(Effect.sync(() => (settling = false))),
          Effect.forkIn(scope),
          Effect.asVoid
        );
      }),
  };
};
export type ForwardedLane<Observation, Node, E> = ReturnType<
  typeof makeForwardedLane<Observation, Node & LaneNode, E>
>;
