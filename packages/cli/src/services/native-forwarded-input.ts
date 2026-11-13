import type { NativeInput } from "@contingency/protocol";

import { nativeHitTest } from "./native-app-hit-test.ts";

/**
 * Forwarded Input reaches the device as it happens. Teaching records it
 * afterwards as the gestures a person made, the way the browser's capture
 * coalesces keystrokes and scroll notches into single actions.
 */
export type ForwardedGesture =
  | { readonly _tag: "tap"; readonly x: number; readonly y: number }
  | { readonly _tag: "long-press"; readonly x: number; readonly y: number }
  | {
      readonly _tag: "swipe";
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
    }
  | {
      readonly _tag: "scroll";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | { readonly _tag: "type"; readonly text: string }
  | { readonly _tag: "key"; readonly key: string; readonly modifiers: number };

/** How far a touch may travel, as a fraction of the screen, and still be a tap. */
const TAP_SLOP = 0.02;
/** How long a still touch is held before it is a long press. */
const LONG_PRESS_MS = 500;
/** Alt (1), Control (2), or Meta (4): a chord, never typed text. */
const CHORD_MODIFIERS = 7;
const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "Shift",
]);

/** A completed gesture and the sequence number of the input that began it. */
export interface RecognizedGesture {
  readonly gesture: ForwardedGesture;
  readonly sequence: number;
}

interface Touch {
  readonly sequence: number;
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly lastX: number;
  readonly lastY: number;
  readonly travel: number;
}

/**
 * Turns Forwarded Input into gestures in the order the user made them. A
 * gesture still in progress — a held touch, a scroll, or text being typed —
 * completes when another kind of input starts or on `flush`.
 */
export const makeGestureRecognizer = () => {
  let touch: Touch | undefined;
  let scroll:
    | {
        readonly gesture: Extract<ForwardedGesture, { _tag: "scroll" }>;
        readonly sequence: number;
      }
    | undefined;
  let typed: { readonly text: string; readonly sequence: number } | undefined;

  const settleTyping = (): RecognizedGesture[] => {
    const settled = typed;
    typed = undefined;
    return settled === undefined || settled.text === ""
      ? []
      : [
          {
            gesture: { _tag: "type", text: settled.text },
            sequence: settled.sequence,
          },
        ];
  };
  const settleScroll = (): RecognizedGesture[] => {
    const settled = scroll;
    scroll = undefined;
    return settled === undefined ? [] : [settled];
  };
  const touchInput = (
    input: Extract<NativeInput, { _tag: "touch" }>,
    sequence: number
  ): RecognizedGesture[] => {
    if (input.action === "down") {
      const settled = [...settleTyping(), ...settleScroll()];
      touch = {
        at: input.at,
        lastX: input.x,
        lastY: input.y,
        sequence,
        travel: 0,
        x: input.x,
        y: input.y,
      };
      return settled;
    }
    if (touch === undefined) {
      // A move or release without its press, such as one that began before
      // capture, has no gesture to complete.
      return [];
    }
    const travel = Math.max(
      touch.travel,
      Math.abs(input.x - touch.x),
      Math.abs(input.y - touch.y)
    );
    if (input.action === "move") {
      touch = { ...touch, lastX: input.x, lastY: input.y, travel };
      return [];
    }
    const started = touch;
    touch = undefined;
    if (travel > TAP_SLOP) {
      return [
        {
          gesture: {
            _tag: "swipe",
            from: { x: started.x, y: started.y },
            to: { x: input.x, y: input.y },
          },
          sequence: started.sequence,
        },
      ];
    }
    return [
      {
        gesture: {
          _tag: input.at - started.at >= LONG_PRESS_MS ? "long-press" : "tap",
          x: started.x,
          y: started.y,
        },
        sequence: started.sequence,
      },
    ];
  };
  const keyInput = (
    input: Extract<NativeInput, { _tag: "key" }>,
    sequence: number
  ): RecognizedGesture[] => {
    if (input.action === "up" || MODIFIER_KEYS.has(input.key)) {
      return [];
    }
    const settled = settleScroll();
    // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
    const chord = (input.modifiers & CHORD_MODIFIERS) !== 0;
    if (!chord && [...input.key].length === 1) {
      typed = {
        sequence: typed?.sequence ?? sequence,
        text: `${typed?.text ?? ""}${input.key}`,
      };
      return settled;
    }
    if (!chord && input.key === "Backspace" && typed !== undefined) {
      typed = { ...typed, text: [...typed.text].slice(0, -1).join("") };
      return settled;
    }
    return [
      ...settled,
      ...settleTyping(),
      {
        gesture: { _tag: "key", key: input.key, modifiers: input.modifiers },
        sequence,
      },
    ];
  };
  const scrollInput = (
    input: Extract<NativeInput, { _tag: "scroll" }>,
    sequence: number
  ): RecognizedGesture[] => {
    const settled = settleTyping();
    scroll =
      scroll === undefined
        ? {
            gesture: {
              _tag: "scroll",
              deltaX: input.deltaX,
              deltaY: input.deltaY,
              x: input.x,
              y: input.y,
            },
            sequence,
          }
        : {
            ...scroll,
            gesture: {
              ...scroll.gesture,
              deltaX: scroll.gesture.deltaX + input.deltaX,
              deltaY: scroll.gesture.deltaY + input.deltaY,
            },
          };
    return settled;
  };
  return {
    /**
     * The gestures this input completed, oldest first. `sequence` numbers
     * the input among everything forwarded in the session.
     */
    feed: (input: NativeInput, sequence: number): RecognizedGesture[] => {
      if (input._tag === "touch") {
        return touchInput(input, sequence);
      }
      if (input._tag === "key") {
        return keyInput(input, sequence);
      }
      return scrollInput(input, sequence);
    },
    /** Completes typing and scrolling. A held touch stays in progress. */
    flush: (): RecognizedGesture[] => [...settleTyping(), ...settleScroll()],
    /** Whether a touch is still held. */
    holding: () => touch !== undefined,
  };
};
export type GestureRecognizer = ReturnType<typeof makeGestureRecognizer>;

interface AttributableNode {
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

/** The control a gesture landed on in an observation whose pixels are `width` by `height`. */
export const gestureTarget = <Node extends AttributableNode>(
  gesture: ForwardedGesture,
  observation: {
    readonly nodes: readonly Node[];
    readonly width: number;
    readonly height: number;
  }
): Node | undefined => {
  if (gesture._tag === "type" || gesture._tag === "key") {
    return undefined;
  }
  const point = gesture._tag === "swipe" ? gesture.from : gesture;
  const hit = nativeHitTest(
    observation.nodes,
    point.x * observation.width,
    point.y * observation.height
  );
  return hit?.covered === true ? undefined : hit;
};

const percent = (value: number) => `${Math.round(value * 100)}%`;
const at = (point: { readonly x: number; readonly y: number }) =>
  `at ${percent(point.x)} across, ${percent(point.y)} down`;
const direction = (gesture: Extract<ForwardedGesture, { _tag: "swipe" }>) => {
  const dx = gesture.to.x - gesture.from.x;
  const dy = gesture.to.y - gesture.from.y;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy < 0 ? "up" : "down";
  }
  return dx < 0 ? "left" : "right";
};
const chordName = (gesture: Extract<ForwardedGesture, { _tag: "key" }>) =>
  [
    // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
    gesture.modifiers & 2 ? "Control" : undefined,
    // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
    gesture.modifiers & 1 ? "Alt" : undefined,
    // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
    gesture.modifiers & 4 ? "Meta" : undefined,
    // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
    gesture.modifiers & 8 ? "Shift" : undefined,
    gesture.key,
  ]
    .filter((part) => part !== undefined)
    .join("+");

const scrollWay = (delta: number, forward: string, backward: string) =>
  delta > 0 ? forward : backward;

/** The Teaching action a gesture becomes, named by its target when it has one. */
/** The Teaching action a gesture becomes. */
export interface GestureDescription {
  readonly kind: string;
  readonly description: string;
  readonly detail: string | null;
}

export const describeGesture = (
  gesture: ForwardedGesture,
  target?: {
    readonly role: string;
    readonly name: string;
    readonly password?: boolean;
  }
): GestureDescription => {
  const named =
    target === undefined ? undefined : `${target.role} ${target.name}`.trim();
  // All gesture variants are handled.
  // oxlint-disable-next-line eslint/default-case
  switch (gesture._tag) {
    case "tap": {
      return {
        description:
          named === undefined ? `Tap ${at(gesture)}` : `Activate ${named}`,
        detail: null,
        kind: "activate",
      };
    }
    case "long-press": {
      return {
        description: `Long press ${named ?? at(gesture)}`,
        detail: null,
        kind: "long-press",
      };
    }
    case "swipe": {
      return {
        description: `Swipe ${direction(gesture)} ${named === undefined ? at(gesture.from) : `from ${named}`}`,
        detail: null,
        kind: "swipe",
      };
    }
    case "scroll": {
      const vertical = Math.abs(gesture.deltaY) >= Math.abs(gesture.deltaX);
      const way = vertical
        ? scrollWay(gesture.deltaY, "down", "up")
        : scrollWay(gesture.deltaX, "right", "left");
      return {
        description: `Scroll ${way} ${named === undefined ? at(gesture) : `in ${named}`}`,
        detail: null,
        kind: "scroll",
      };
    }
    case "type": {
      return {
        description:
          named === undefined
            ? "Enter text in the focused field"
            : `Enter text in ${named}`,
        // Text typed into a password field is never evidence.
        detail: target?.password === true ? null : gesture.text,
        kind: "fill",
      };
    }
    case "key": {
      return gesture.key === "GoBack" && gesture.modifiers === 0
        ? { description: "Go back", detail: null, kind: "back" }
        : {
            description: `Press ${chordName(gesture)}`,
            detail: null,
            kind: "key",
          };
    }
  }
};
