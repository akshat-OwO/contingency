import type { NativeInput } from "@contingency/protocol";
import { Cause, Effect } from "effect";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";

import { keyboardModifiers } from "@/components/browser/browser-input";

/** The most inputs one request carries; the protocol refuses more. */
const INPUT_BATCH_LIMIT = 256;

const sameDirection = (previous: number, next: number) =>
  previous === 0 || next === 0 || Math.sign(previous) === Math.sign(next);

/** Two inputs that one request may carry as one, or undefined. */
const combine = (
  previous: NativeInput,
  next: NativeInput
): NativeInput | undefined => {
  if (
    previous._tag === "touch" &&
    next._tag === "touch" &&
    previous.action === "move" &&
    next.action === "move"
  ) {
    return next;
  }
  if (
    previous._tag === "scroll" &&
    next._tag === "scroll" &&
    previous.x === next.x &&
    previous.y === next.y &&
    sameDirection(previous.deltaX, next.deltaX) &&
    sameDirection(previous.deltaY, next.deltaY)
  ) {
    return {
      ...next,
      deltaX: previous.deltaX + next.deltaX,
      deltaY: previous.deltaY + next.deltaY,
    };
  }
  return undefined;
};

/**
 * Sends a native session's Forwarded Input in the order the user made it,
 * one request at a time. What queues while a request is in flight goes out
 * together as the next request, so input never waits a round trip behind
 * each earlier input. Consecutive moves collapse into the latest, and
 * compatible scrolls add together.
 */
export const makeNativeInputQueue = (
  send: (
    inputs: readonly [NativeInput, ...NativeInput[]]
  ) => Effect.Effect<unknown, unknown>,
  /** Hears why a request failed: its error, or the defect that ended it. */
  onError?: (cause: unknown) => void
) => {
  const queued: NativeInput[] = [];
  let sending = false;
  const drain = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const [first, ...rest] = queued.splice(0, INPUT_BATCH_LIMIT);
      if (first === undefined) {
        sending = false;
        return Effect.void;
      }
      return send([first, ...rest]).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // Input that could not reach the device is not retried: the screen
            // it was aimed at may already be gone.
            queued.length = 0;
            onError?.(Cause.squash(cause));
          })
        ),
        Effect.andThen(drain)
      );
    });
  return (input: NativeInput): void => {
    const last = queued.at(-1);
    const combined = last === undefined ? undefined : combine(last, input);
    if (combined === undefined) {
      queued.push(input);
    } else {
      queued[queued.length - 1] = combined;
    }
    if (sending) {
      return;
    }
    sending = true;
    Effect.runFork(drain());
  };
};

const fraction = (value: number) => Math.min(Math.max(value, 0), 1);
/** Pixels per wheel delta unit, by `WheelEvent.deltaMode`: pixel, line, page. */
const WHEEL_DELTA_SCALE = [1, 40, 800] as const;
const pointOn = (
  element: Element,
  event: { readonly clientX: number; readonly clientY: number }
) => {
  const box = element.getBoundingClientRect();
  return box.width <= 0 || box.height <= 0
    ? undefined
    : {
        x: fraction((event.clientX - box.left) / box.width),
        y: fraction((event.clientY - box.top) / box.height),
      };
};

/**
 * The canvas events a native device display forwards: one finger, the wheel,
 * and the keyboard while the display has focus. `enabled` is read on every
 * event, so a session that stops accepting input sends nothing. `onInput`
 * hears each input as it is sent, for the first-response probe.
 */
export const makeNativeInputHandlers = (
  dispatch: (input: NativeInput) => void,
  enabled: () => boolean,
  onInput?: (input: NativeInput) => void
) => {
  let finger: { readonly id: number; x: number; y: number } | undefined;
  const send = (input: NativeInput) => {
    dispatch(input);
    onInput?.(input);
  };
  const release = (event: PointerEvent<HTMLElement>) => {
    if (finger === undefined || finger.id !== event.pointerId) {
      return;
    }
    const point = pointOn(event.currentTarget, event) ?? finger;
    finger = undefined;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Without capture there is nothing to release.
    }
    send({ _tag: "touch", action: "up", at: performance.now(), ...point });
  };
  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled()) {
        return;
      }
      event.preventDefault();
      send({
        _tag: "key",
        action: "down",
        at: performance.now(),
        code: event.code.slice(0, 32),
        key: event.key.slice(0, 32),
        modifiers: keyboardModifiers(event),
      });
    },
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled()) {
        return;
      }
      event.preventDefault();
      send({
        _tag: "key",
        action: "up",
        at: performance.now(),
        code: event.code.slice(0, 32),
        key: event.key.slice(0, 32),
        modifiers: keyboardModifiers(event),
      });
    },
    onPointerCancel: release,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (
        !enabled() ||
        finger !== undefined ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      const point = pointOn(event.currentTarget, event);
      if (point === undefined) {
        return;
      }
      event.preventDefault();
      event.currentTarget.focus();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Without capture a drag that leaves the display still ends on release.
      }
      finger = { id: event.pointerId, ...point };
      send({ _tag: "touch", action: "down", at: performance.now(), ...point });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (finger === undefined || finger.id !== event.pointerId) {
        return;
      }
      const point = pointOn(event.currentTarget, event);
      if (point === undefined) {
        return;
      }
      finger.x = point.x;
      finger.y = point.y;
      send({ _tag: "touch", action: "move", at: performance.now(), ...point });
    },
    onPointerUp: release,
    onWheel: (event: WheelEvent<HTMLElement>) => {
      if (!enabled() || finger !== undefined) {
        return;
      }
      const point = pointOn(event.currentTarget, event);
      if (point === undefined) {
        return;
      }
      // Line and page deltas become pixels, as the browser Workspace reads them.
      const scale = WHEEL_DELTA_SCALE[event.deltaMode] ?? 1;
      send({
        _tag: "scroll",
        at: performance.now(),
        deltaX: Math.max(Math.min(event.deltaX * scale, 10_000), -10_000),
        deltaY: Math.max(Math.min(event.deltaY * scale, 10_000), -10_000),
        ...point,
      });
    },
  };
};
