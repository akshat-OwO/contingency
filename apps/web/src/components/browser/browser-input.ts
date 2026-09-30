import type {
  BrowserInput,
  BrowserStreamEvent,
  MouseButton,
} from "@contingency/protocol";
import { Effect } from "effect";
import type { KeyboardEvent, PointerEvent } from "react";

interface KeyboardKeyInfo {
  readonly keyCode: number;
  readonly text?: string;
}

export const keyboardKeyInfo: ReadonlyMap<string, KeyboardKeyInfo> = new Map([
  ["ArrowDown", { keyCode: 40 }],
  ["ArrowLeft", { keyCode: 37 }],
  ["ArrowRight", { keyCode: 39 }],
  ["ArrowUp", { keyCode: 38 }],
  ["Backspace", { keyCode: 8, text: "\b" }],
  ["Delete", { keyCode: 46 }],
  ["End", { keyCode: 35 }],
  ["Enter", { keyCode: 13, text: "\r" }],
  ["Escape", { keyCode: 27 }],
  ["Home", { keyCode: 36 }],
  ["PageDown", { keyCode: 34 }],
  ["PageUp", { keyCode: 33 }],
  ["Tab", { keyCode: 9, text: "\t" }],
]);

const printableVirtualKeyCodes: ReadonlyMap<string, number> = new Map([
  ["Backquote", 192],
  ["Backslash", 220],
  ["BracketLeft", 219],
  ["BracketRight", 221],
  ["Comma", 188],
  ["Equal", 187],
  ["IntlBackslash", 226],
  ["Minus", 189],
  ["NumpadAdd", 107],
  ["NumpadDecimal", 110],
  ["NumpadDivide", 111],
  ["NumpadMultiply", 106],
  ["NumpadSubtract", 109],
  ["Period", 190],
  ["Quote", 222],
  ["Semicolon", 186],
  ["Slash", 191],
  ["Space", 32],
]);

const virtualKeyCode = (code: string, key: string): number => {
  const specialKey = keyboardKeyInfo.get(key);
  if (specialKey !== undefined) {
    return specialKey.keyCode;
  }

  const printableKey = printableVirtualKeyCodes.get(code);
  if (printableKey !== undefined) {
    return printableKey;
  }

  if (/^Key[A-Z]$/u.test(code) || /^Digit[0-9]$/u.test(code)) {
    return code.codePointAt(code.length - 1) ?? 0;
  }
  if (/^Numpad[0-9]$/u.test(code)) {
    return (code.codePointAt(code.length - 1) ?? 48) + 48;
  }
  return 0;
};

export const pointerButton = (button: number): typeof MouseButton.Type => {
  switch (button) {
    case 1: {
      return "middle";
    }
    case 2: {
      return "right";
    }
    case 3: {
      return "back";
    }
    case 4: {
      return "forward";
    }
    default: {
      return "left";
    }
  }
};

export const keyboardModifiers = (
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
): number =>
  (event.altKey ? 1 : 0) +
  (event.ctrlKey ? 2 : 0) +
  (event.metaKey ? 4 : 0) +
  (event.shiftKey ? 8 : 0);

const viewportSizes = new WeakMap<
  HTMLCanvasElement,
  { readonly width: number; readonly height: number }
>();

export const canvasViewportSize = (canvas: HTMLCanvasElement) =>
  viewportSizes.get(canvas) ?? { height: canvas.height, width: canvas.width };

export const mousePosition = (
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY">
) => {
  const bounds = canvas.getBoundingClientRect();
  const viewport = canvasViewportSize(canvas);
  return {
    x: ((event.clientX - bounds.left) * viewport.width) / bounds.width,
    y: ((event.clientY - bounds.top) * viewport.height) / bounds.height,
  };
};

/**
 * The canvas events one interactive browser viewport forwards, built once so
 * every interface that lets a person drive the browser sends the same input.
 */
/**
 * Keeping the pointer on the canvas for the duration of a drag. It is a
 * convenience of the real browser, not part of the input the page receives,
 * so an environment that cannot capture pointers still forwards the event.
 */
const capturePointer = (
  canvas: HTMLCanvasElement,
  pointerId: number,
  take: boolean
): void => {
  try {
    if (take) {
      canvas.setPointerCapture(pointerId);
    } else if (canvas.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
  } catch {
    // Pointer capture is unavailable here; the input still reaches the page.
    canvas.blur();
    canvas.focus();
  }
};

export { makeBrowserInputQueue } from "./browser-input-queue";

export const makeBrowserInputHandlers = (
  dispatchInput: (input: BrowserInput) => void
) => {
  const handlePointer = (
    event: PointerEvent<HTMLCanvasElement>,
    eventType: "mousePressed" | "mouseReleased"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget;
    const position = mousePosition(canvas, event);
    if (eventType === "mousePressed") {
      canvas.focus();
      capturePointer(canvas, event.pointerId, true);
    } else {
      capturePointer(canvas, event.pointerId, false);
    }
    dispatchInput({
      ...position,
      button: pointerButton(event.button),
      clickCount: Math.max(1, event.detail),
      eventType,
      modifiers: keyboardModifiers(event),
      type: "input_mouse",
    });
  };

  return {
    handleKey: (
      event: KeyboardEvent<HTMLCanvasElement>,
      eventType: "keyDown" | "keyUp"
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const info = keyboardKeyInfo.get(event.key);
      const text =
        eventType === "keyDown"
          ? (info?.text ?? (event.key.length === 1 ? event.key : undefined))
          : undefined;
      const windowsVirtualKeyCode = virtualKeyCode(event.code, event.key);
      const input = {
        code: event.code,
        eventType,
        key: event.key,
        modifiers: keyboardModifiers(event),
        type: "input_keyboard",
        windowsVirtualKeyCode,
      } satisfies BrowserInput;
      dispatchInput(text === undefined ? input : { ...input, text });
    },
    handlePointerDown: (event: PointerEvent<HTMLCanvasElement>) => {
      handlePointer(event, "mousePressed");
    },
    handlePointerMove: (event: PointerEvent<HTMLCanvasElement>) => {
      dispatchInput({
        ...mousePosition(event.currentTarget, event),
        button: "none",
        eventType: "mouseMoved",
        modifiers: keyboardModifiers(event),
        type: "input_mouse",
      });
    },
    handlePointerUp: (event: PointerEvent<HTMLCanvasElement>) => {
      handlePointer(event, "mouseReleased");
    },
  };
};

export const renderFrame = (
  canvas: HTMLCanvasElement,
  event: Extract<BrowserStreamEvent, { readonly type: "frame" }>,
  isCurrent: () => boolean = () => true,
  onRendered?: (timing: {
    readonly decodeMs: number;
    readonly drawMs: number;
  }) => void
) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async (signal) => {
      const started = performance.now();
      const bytes =
        event.data.buffer instanceof ArrayBuffer
          ? new Uint8Array(
              event.data.buffer,
              event.data.byteOffset,
              event.data.byteLength
            )
          : new Uint8Array(event.data);
      const bitmap = await globalThis.createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" })
      );
      const decoded = performance.now();
      try {
        if (signal.aborted || !isCurrent()) {
          return false;
        }
        const context = canvas.getContext("2d", { alpha: false });
        if (context === null) {
          throw new Error(
            "The live browser canvas could not open a rendering context."
          );
        }
        // Writing `width` or `height` resets the canvas — it drops the backing
        // store, re-rasterizes, and re-lays out the element, which the user
        // sees as the frame scaling for one paint. Frames only arrive when the
        // Page repaints, so an unconditional write made every state update in
        // the Page flash (#237). The size a Page reports does not change
        // between repaints, so writing it only when it changes is the same
        // canvas without the flash.
        viewportSizes.set(canvas, {
          height: event.metadata.deviceHeight,
          width: event.metadata.deviceWidth,
        });
        const cssWidth = `min(100%, ${event.metadata.deviceWidth}px)`;
        const cssHeight = `min(100%, ${event.metadata.deviceHeight}px)`;
        if (canvas.style.maxWidth !== cssWidth) {
          canvas.style.maxWidth = cssWidth;
        }
        if (canvas.style.maxHeight !== cssHeight) {
          canvas.style.maxHeight = cssHeight;
        }
        if (canvas.width !== bitmap.width) {
          canvas.width = bitmap.width;
        }
        if (canvas.height !== bitmap.height) {
          canvas.height = bitmap.height;
        }
        // The capture is the whole viewport, scaled to the stream's ceiling, so
        // the frame is drawn whole. Cropping it to the canvas would show the
        // top-left corner magnified whenever the two disagree.
        context.drawImage(
          bitmap,
          0,
          0,
          bitmap.width,
          bitmap.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        onRendered?.({
          decodeMs: decoded - started,
          drawMs: performance.now() - decoded,
        });
        return true;
      } finally {
        bitmap.close();
      }
    },
  });
