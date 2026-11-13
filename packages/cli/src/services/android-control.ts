import type { NativeInput } from "@contingency/protocol";

/**
 * Forwarded Input as scrcpy control packets, for the control socket the
 * display stream already opens. Positions are in the current video frame's
 * pixels; the server maps them to the display and ignores a packet whose
 * frame size is stale.
 */
const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH = 2;
const TYPE_INJECT_SCROLL = 3;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const BUTTON_PRIMARY = 1;
const PRESSURE_FULL = 0xff_ff;
/** One finger, as the vendored hub transport sends it. */
const FINGER = 0n;
/** scrcpy carries scroll as a fraction of 16 notches. */
const SCROLL_RANGE = 16;
/** A browser wheel notch, in pixels. */
const WHEEL_NOTCH = 100;
export const MAX_TEXT_BYTES = 300;

const META_SHIFT_ON = 0x1;
const META_ALT_ON = 0x2;
const META_CTRL_ON = 0x10_00;
const META_META_ON = 0x1_00_00;

/** Keys with no text of their own, by `KeyboardEvent.key`. */
const namedKeycodes: ReadonlyMap<string, number> = new Map([
  ["ArrowDown", 20],
  ["ArrowLeft", 21],
  ["ArrowRight", 22],
  ["ArrowUp", 19],
  ["Backspace", 67],
  ["Delete", 112],
  ["End", 123],
  ["Enter", 66],
  ["Escape", 111],
  // The Workspace's Back key.
  ["GoBack", 4],
  ["Home", 122],
  ["PageDown", 93],
  ["PageUp", 92],
  ["Tab", 61],
]);

/** The Android keycode for a physical key, for chords such as Control+A. */
const physicalKeycode = (code: string): number | undefined => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;
  if (letter !== undefined) {
    return 29 + (letter.codePointAt(0) ?? 65) - 65;
  }
  const digit = /^Digit(?<digit>\d)$/u.exec(code)?.groups?.digit;
  if (digit !== undefined) {
    return 7 + Number(digit);
  }
  return code === "Space" ? 62 : undefined;
};

const metaState = (modifiers: number) =>
  // oxlint-disable-next-line eslint/no-bitwise -- Workspace and Android modifier masks.
  (modifiers & 1 ? META_ALT_ON : 0) |
  // oxlint-disable-next-line eslint/no-bitwise -- Workspace and Android modifier masks.
  (modifiers & 2 ? META_CTRL_ON : 0) |
  // oxlint-disable-next-line eslint/no-bitwise -- Workspace and Android modifier masks.
  (modifiers & 4 ? META_META_ON : 0) |
  // oxlint-disable-next-line eslint/no-bitwise -- Workspace and Android modifier masks.
  (modifiers & 8 ? META_SHIFT_ON : 0);

const position = (
  buffer: Buffer,
  offset: number,
  point: { readonly x: number; readonly y: number },
  screen: { readonly width: number; readonly height: number }
) => {
  buffer.writeInt32BE(
    Math.round(Math.min(Math.max(point.x, 0), 1) * (screen.width - 1)),
    offset
  );
  buffer.writeInt32BE(
    Math.round(Math.min(Math.max(point.y, 0), 1) * (screen.height - 1)),
    offset + 4
  );
  buffer.writeUInt16BE(screen.width, offset + 8);
  buffer.writeUInt16BE(screen.height, offset + 10);
};

const touchActions = {
  down: ACTION_DOWN,
  move: ACTION_MOVE,
  up: ACTION_UP,
} as const;

const touchPacket = (
  input: Extract<NativeInput, { _tag: "touch" }>,
  screen: { readonly width: number; readonly height: number }
) => {
  const buffer = Buffer.alloc(32);
  const action = touchActions[input.action];
  buffer.writeUInt8(TYPE_INJECT_TOUCH, 0);
  buffer.writeUInt8(action, 1);
  buffer.writeBigInt64BE(FINGER, 2);
  position(buffer, 10, input, screen);
  buffer.writeUInt16BE(action === ACTION_UP ? 0 : PRESSURE_FULL, 22);
  buffer.writeUInt32BE(BUTTON_PRIMARY, 24);
  buffer.writeUInt32BE(action === ACTION_UP ? 0 : BUTTON_PRIMARY, 28);
  return buffer;
};

/** A signed 16-bit fixed-point fraction, as scrcpy encodes scroll. */
const fixedPoint = (value: number) =>
  Math.round(Math.min(Math.max(value, -1), 1 - 1 / 0x80_00) * 0x80_00);

const scrollPacket = (
  input: Extract<NativeInput, { _tag: "scroll" }>,
  screen: { readonly width: number; readonly height: number }
) => {
  const buffer = Buffer.alloc(21);
  buffer.writeUInt8(TYPE_INJECT_SCROLL, 0);
  position(buffer, 1, input, screen);
  // A wheel turned down scrolls the content up: Android's axes point the other way.
  buffer.writeInt16BE(
    fixedPoint(-input.deltaX / WHEEL_NOTCH / SCROLL_RANGE),
    13
  );
  buffer.writeInt16BE(
    fixedPoint(-input.deltaY / WHEEL_NOTCH / SCROLL_RANGE),
    15
  );
  buffer.writeInt32BE(0, 17);
  return buffer;
};

const keyPacket = (action: number, keycode: number, meta: number) => {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(TYPE_INJECT_KEYCODE, 0);
  buffer.writeUInt8(action, 1);
  buffer.writeInt32BE(keycode, 2);
  buffer.writeInt32BE(0, 6);
  buffer.writeInt32BE(meta, 10);
  return buffer;
};

const textPacket = (text: string) => {
  const bytes = Buffer.from(text, "utf-8").subarray(0, MAX_TEXT_BYTES);
  const buffer = Buffer.alloc(5 + bytes.length);
  buffer.writeUInt8(TYPE_INJECT_TEXT, 0);
  buffer.writeUInt32BE(bytes.length, 1);
  bytes.copy(buffer, 5);
  return buffer;
};

/**
 * The packets one input becomes. Printable text is injected as text, so the
 * device's keyboard layout never changes what was typed; other keys and
 * chords are keycodes. A modifier key alone, or a key Android has no code
 * for, sends nothing.
 */
export const androidControlPackets = (
  input: NativeInput,
  screen: { readonly width: number; readonly height: number }
): readonly Buffer[] => {
  if (input._tag === "touch") {
    return [touchPacket(input, screen)];
  }
  if (input._tag === "scroll") {
    return [scrollPacket(input, screen)];
  }
  const meta = metaState(input.modifiers);
  // oxlint-disable-next-line eslint/no-bitwise -- Workspace modifier mask.
  const chord = (input.modifiers & 7) !== 0;
  if (!chord && [...input.key].length === 1) {
    return input.action === "down" ? [textPacket(input.key)] : [];
  }
  const keycode =
    namedKeycodes.get(input.key) ??
    (chord ? physicalKeycode(input.code) : undefined);
  return keycode === undefined
    ? []
    : [
        keyPacket(
          input.action === "down" ? ACTION_DOWN : ACTION_UP,
          keycode,
          meta
        ),
      ];
};
