import type { BrowserInput, NativeInput } from "@contingency/protocol";

/**
 * Measures how long the user waits to see their input do something: from the
 * input to the first drawn frame that differs from the screen before it. Each
 * measurement is a `performance.measure` named
 * `contingency:first-visible-response:<platform>:<gesture>`, so it carries
 * only a duration, and the browser's own buffer bounds how many are kept.
 *
 * The probe compares a small downsampled copy of the display, so it costs one
 * tiny draw per frame while a measurement is open and nothing otherwise.
 */
const SAMPLE_WIDTH = 24;
const SAMPLE_HEIGHT = 48;
/** Mean per-channel change that counts as the screen responding. */
const CHANGE_THRESHOLD = 2;
/** A response slower than this is not attributed to the input. */
const GIVE_UP_MS = 10_000;

export type ProbeGesture = "tap" | "scroll" | "key" | "drag";
const MODIFIER_KEYS = new Set(["Alt", "CapsLock", "Control", "Meta", "Shift"]);

export const makeFirstResponseProbe = (
  platform: "android" | "ios" | "browser",
  display: () => HTMLCanvasElement | null
) => {
  let sampler: CanvasRenderingContext2D | null | undefined;
  let open:
    | {
        readonly gesture: ProbeGesture;
        readonly start: number;
        readonly before: Uint8ClampedArray;
      }
    | undefined;
  const sample = (): Uint8ClampedArray | undefined => {
    const source = display();
    if (source === null || source.width === 0 || source.height === 0) {
      return undefined;
    }
    if (sampler === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_WIDTH;
      canvas.height = SAMPLE_HEIGHT;
      sampler = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (sampler === null) {
      return undefined;
    }
    try {
      sampler.drawImage(source, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
      return sampler.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
    } catch {
      // A display that cannot be read is not measured.
      return undefined;
    }
  };
  return {
    /** A frame was just drawn on the display. */
    frame: () => {
      const measuring = open;
      if (measuring === undefined) {
        return;
      }
      const end = performance.now();
      if (end - measuring.start > GIVE_UP_MS) {
        open = undefined;
        return;
      }
      const after = sample();
      if (after === undefined || after.length !== measuring.before.length) {
        return;
      }
      let change = 0;
      for (let index = 0; index < after.length; index += 1) {
        change += Math.abs(
          (after[index] ?? 0) - (measuring.before[index] ?? 0)
        );
      }
      if (change / after.length < CHANGE_THRESHOLD) {
        return;
      }
      open = undefined;
      performance.measure(
        `contingency:first-visible-response:${platform}:${measuring.gesture}`,
        { end, start: measuring.start }
      );
    },
    /** The user just made a gesture. An open measurement keeps its start. */
    input: (gesture: ProbeGesture) => {
      if (open !== undefined && performance.now() - open.start < GIVE_UP_MS) {
        return;
      }
      const before = sample();
      open =
        before === undefined
          ? undefined
          : { before, gesture, start: performance.now() };
    },
  };
};
export type FirstResponseProbe = ReturnType<typeof makeFirstResponseProbe>;

/**
 * Starts a measurement for each gesture in a native display's Forwarded
 * Input. A tap is measured from its release, as a browser click is; a drag
 * from the move that first carries it past a tap's travel, since the content
 * should follow the finger from then on; a key from its press; a scroll from
 * its first notch.
 */
export const probeNativeInput = (probe: FirstResponseProbe) => {
  let down:
    | { readonly x: number; readonly y: number; dragging: boolean }
    | undefined;
  return (input: NativeInput) => {
    if (input._tag === "scroll") {
      probe.input("scroll");
    } else if (input._tag === "key") {
      if (input.action === "down" && !MODIFIER_KEYS.has(input.key)) {
        probe.input("key");
      }
    } else if (input.action === "down") {
      down = { dragging: false, x: input.x, y: input.y };
    } else if (input.action === "move") {
      if (
        down !== undefined &&
        !down.dragging &&
        Math.max(Math.abs(input.x - down.x), Math.abs(input.y - down.y)) > 0.02
      ) {
        down.dragging = true;
        probe.input("drag");
      }
    } else {
      const tapped = down !== undefined && !down.dragging;
      down = undefined;
      if (tapped) {
        probe.input("tap");
      }
    }
  };
};

/**
 * Starts a measurement for each gesture in the browser Workspace's input, on
 * the same terms as `probeNativeInput`, so the two are comparable.
 */
export const probeBrowserInput = (probe: FirstResponseProbe) => {
  let pressed:
    | { readonly x: number; readonly y: number; dragging: boolean }
    | undefined;
  return (input: BrowserInput) => {
    if (input.type === "input_keyboard") {
      if (
        input.eventType === "keyDown" &&
        input.key !== undefined &&
        input.key !== null &&
        !MODIFIER_KEYS.has(input.key)
      ) {
        probe.input("key");
      }
    } else if (input.eventType === "mouseWheel") {
      probe.input("scroll");
    } else if (input.eventType === "mousePressed") {
      pressed = { dragging: false, x: input.x, y: input.y };
    } else if (input.eventType === "mouseMoved") {
      // Browser points are CSS pixels; a few pixels of travel is still a click.
      if (
        pressed !== undefined &&
        !pressed.dragging &&
        Math.hypot(input.x - pressed.x, input.y - pressed.y) > 8
      ) {
        pressed.dragging = true;
        probe.input("drag");
      }
    } else if (input.eventType === "mouseReleased") {
      const clicked = pressed !== undefined && !pressed.dragging;
      pressed = undefined;
      if (clicked) {
        probe.input("tap");
      }
    }
  };
};
