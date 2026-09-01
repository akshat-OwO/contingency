import type {
  BrowserInput,
  BrowserStreamEvent,
  MouseButton,
} from "@contingency/protocol";
import { Effect } from "effect";
import type { KeyboardEvent, PointerEvent } from "react";

export const keyboardKeyInfo: Readonly<
  Record<string, { readonly keyCode: number; readonly text?: string }>
> = {
  ArrowDown: { keyCode: 40 },
  ArrowLeft: { keyCode: 37 },
  ArrowRight: { keyCode: 39 },
  ArrowUp: { keyCode: 38 },
  Backspace: { keyCode: 8, text: "\b" },
  Delete: { keyCode: 46 },
  End: { keyCode: 35 },
  Enter: { keyCode: 13, text: "\r" },
  Escape: { keyCode: 27 },
  Home: { keyCode: 36 },
  PageDown: { keyCode: 34 },
  PageUp: { keyCode: 33 },
  Tab: { keyCode: 9, text: "\t" },
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

export const mousePosition = (
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY">
) => {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
    y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
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
      const info = keyboardKeyInfo[event.key];
      const text =
        eventType === "keyDown"
          ? (info?.text ?? (event.key.length === 1 ? event.key : undefined))
          : undefined;
      const windowsVirtualKeyCode =
        info?.keyCode ??
        (event.key.length === 1 ? (event.key.codePointAt(0) ?? 0) : 0);
      dispatchInput({
        code: event.code,
        eventType,
        key: event.key,
        modifiers: keyboardModifiers(event),
        ...(text === undefined ? {} : { text }),
        type: "input_keyboard",
        windowsVirtualKeyCode,
      });
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
  event: Extract<BrowserStreamEvent, { readonly type: "frame" }>
) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const binary = globalThis.atob(event.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
      }

      const bitmap = await globalThis.createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" })
      );
      const context = canvas.getContext("2d", { alpha: false });
      if (context !== null) {
        canvas.width = event.metadata.deviceWidth;
        canvas.height = event.metadata.deviceHeight;
        const sourceWidth = Math.min(bitmap.width, canvas.width);
        const sourceHeight = Math.min(bitmap.height, canvas.height);
        context.drawImage(
          bitmap,
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
      }
      bitmap.close();
    },
  }).pipe(Effect.ignore);
