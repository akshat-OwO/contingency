import type { BrowserRpcErrorType } from "@contingency/protocol";
import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect } from "effect";

import type { CdpConnection } from "./cdp-client";
import {
  asString,
  isRecord,
  makeCdpConnection,
  openWebSocket,
  selectPageTarget,
} from "./cdp-client";

const inputError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("agent_browser_failed", message);

/**
 * CDP modifier bitmask. A held modifier is not remembered by the browser
 * between synthesized events, so every event dispatched while one is down must
 * carry the mask itself.
 */
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;

export type ModifierKey = keyof typeof MODIFIER_BITS;

export const isModifierKey = (key: string): key is ModifierKey =>
  Object.hasOwn(MODIFIER_BITS, key);

/**
 * Shift is the only modifier that still produces a character. With Control,
 * Meta, or Alt held the keystroke is an accelerator, so Chrome sends no text —
 * and sending it anyway raises a spurious `keypress` a page can act on.
 */
export const suppressesText = (held: Iterable<string>): boolean => {
  for (const key of held) {
    if (isModifierKey(key) && key !== "Shift") {
      return true;
    }
  }
  return false;
};

export const modifierMask = (held: Iterable<string>): number => {
  let mask = 0;
  for (const key of held) {
    if (isModifierKey(key)) {
      // CDP defines `modifiers` as a bitmask, so this is arithmetic on a
      // protocol field rather than a mistyped logical operator.
      // oxlint-disable-next-line eslint/no-bitwise, oxc/bad-bitwise-operator
      mask |= MODIFIER_BITS[key];
    }
  }
  return mask;
};

interface KeyDefinition {
  readonly code: string;
  readonly keyCode: number;
  /** Text the key inserts. Absent for keys that produce no character. */
  readonly text?: string;
}

/**
 * Chrome needs `code` and `windowsVirtualKeyCode` to raise a faithful event; a
 * bare `key` produces a keydown a page cannot act on. Only the named keys a
 * Recorder emits need a table — a single printable character derives its own.
 */
const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  " ": { code: "Space", keyCode: 32, text: " " },
  Alt: { code: "AltLeft", keyCode: 18 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Delete: { code: "Delete", keyCode: 46 },
  End: { code: "End", keyCode: 35 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Home: { code: "Home", keyCode: 36 },
  Meta: { code: "MetaLeft", keyCode: 91 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Tab: { code: "Tab", keyCode: 9 },
};

const printableDefinition = (key: string): KeyDefinition | undefined => {
  if ([...key].length !== 1) {
    return undefined;
  }
  const upper = key.toUpperCase();
  const codePoint = upper.codePointAt(0) ?? 0;
  if (upper >= "A" && upper <= "Z") {
    return { code: `Key${upper}`, keyCode: codePoint, text: key };
  }
  if (key >= "0" && key <= "9") {
    return { code: `Digit${key}`, keyCode: codePoint, text: key };
  }
  // Punctuation still produces text; the code is not knowable from the
  // character alone, and pages that matter read `key` and `text`.
  return { code: "", keyCode: codePoint, text: key };
};

export const keyDefinition = (key: string): KeyDefinition | undefined =>
  NAMED_KEYS[key] ?? printableDefinition(key);

export interface DispatchKeyOptions {
  readonly cdpUrl: string;
  /** Modifiers already held, including this key when it is itself a modifier. */
  readonly held: readonly string[];
  readonly key: string;
  readonly requestedTabId: string | undefined;
  readonly type: "keyDown" | "keyUp";
}

export interface DispatchModifiedClickOptions {
  readonly cdpUrl: string;
  readonly held: readonly string[];
  readonly requestedTabId: string | undefined;
  /** CSS or XPath, so the element clicked can be identified exactly. */
  readonly selector: string;
}

const withPageSession = <A>(
  cdpUrl: string,
  requestedTabId: string | undefined,
  use: (
    connection: CdpConnection,
    sessionId: string
  ) => Effect.Effect<A, BrowserRpcErrorType>
): Effect.Effect<A, BrowserRpcErrorType> =>
  Effect.scoped(
    Effect.gen(function* runWithPageSession() {
      const socket = yield* openWebSocket(cdpUrl);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          socket.close();
        })
      );
      const connection = makeCdpConnection(socket, () => {
        // Input dispatch is request/response; no events are consumed.
      });
      yield* Effect.addFinalizer(() => connection.close);

      const targetsResult = yield* connection.send("Target.getTargets");
      const targetInfos =
        isRecord(targetsResult) && Array.isArray(targetsResult.targetInfos)
          ? targetsResult.targetInfos
          : [];
      const targetId = yield* selectPageTarget(
        connection,
        targetInfos,
        requestedTabId
      );

      const attachResult = yield* connection.send("Target.attachToTarget", {
        flatten: true,
        targetId,
      });
      const sessionId = isRecord(attachResult)
        ? asString(attachResult.sessionId)
        : undefined;
      if (sessionId === undefined) {
        return yield* Effect.fail(
          inputError("Unable to attach to the page for input.")
        );
      }

      return yield* use(connection, sessionId);
    })
  );

/**
 * Dispatch one half of a keystroke. The browser tool exposes only `press`, a
 * complete keypress, which cannot leave a key held — so a Flow's `keyDown` and
 * `keyUp` Steps go straight to CDP to keep the semantics the Recorder captured.
 *
 * Modifiers never reach here. Leaving one physically down makes Chrome emit
 * roughly seven thousand `keydown` events per second for as long as it is held
 * — measured, with both `keyDown` and `rawKeyDown` — which floods the page and
 * wedges the Run. A held modifier is carried as a mask on the events dispatched
 * while it is down instead, which is what a page reads as `event.shiftKey`.
 */
export const dispatchKey = (
  options: DispatchKeyOptions
): Effect.Effect<void, BrowserRpcErrorType> => {
  const definition = keyDefinition(options.key);
  if (definition === undefined) {
    return Effect.fail(
      inputError(`Unsupported key for replay: ${options.key}`)
    );
  }

  // A key that inserts nothing, a key held under an accelerator modifier, and
  // a release all dispatch without text, which is what selects `rawKeyDown`.
  const insertsText =
    options.type === "keyDown" &&
    definition.text !== undefined &&
    !isModifierKey(options.key) &&
    !suppressesText(options.held);

  return withPageSession(
    options.cdpUrl,
    options.requestedTabId,
    (connection, sessionId) =>
      connection
        .send(
          "Input.dispatchKeyEvent",
          {
            code: definition.code,
            key: options.key,
            modifiers: modifierMask(options.held),
            nativeVirtualKeyCode: definition.keyCode,
            ...(insertsText
              ? { text: definition.text, unmodifiedText: definition.text }
              : {}),
            type:
              options.type === "keyDown" && !insertsText
                ? "rawKeyDown"
                : options.type,
            windowsVirtualKeyCode: definition.keyCode,
          },
          sessionId
        )
        .pipe(Effect.asVoid)
  );
};

/**
 * `text=` matching belongs to the browser tool's own engine — normalised
 * whitespace, substring rules, deepest-match preference — and approximating it
 * here would risk resolving a different element than an ordinary click does,
 * which is the failure this whole path exists to prevent. Every other form the
 * Runner produces resolves exactly in page context.
 */
const isVerifiableSelector = (selector: string): boolean =>
  !selector.startsWith("text=");

/**
 * Resolve the target, measure it, and confirm nothing covers it, in one page
 * evaluation.
 *
 * Splitting these would reintroduce the race the check exists to close: an
 * overlay can appear, or layout can move, between measuring a centre point and
 * clicking it, and a coordinate click reports success wherever it lands.
 *
 * CSS resolves with `querySelector`, which matches the browser tool — neither
 * pierces an open shadow root, verified against a shadow-only fixture where
 * both return nothing. XPath resolves with `document.evaluate`.
 */
const HIT_TEST = `(() => {
  const selector = SELECTOR;
  const el = selector.startsWith("/")
    ? document.evaluate(selector, document, null, 9, null).singleNodeValue
    : document.querySelector(selector);
  if (el === null || el === undefined) {
    return { reason: "no longer resolves", ok: false };
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return { reason: "has no size", ok: false };
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit === null) { return { reason: "is outside the viewport", ok: false }; }
  if (!(hit === el || el.contains(hit))) {
    return { reason: "is covered by <" + hit.tagName.toLowerCase() + ">", ok: false };
  }
  return { ok: true, x, y };
})()`;

/**
 * Click through CDP so a modifier held by an earlier Step reaches the page. The
 * browser tool's own click is preferred everywhere else, because it resolves
 * selectors and refuses to click through a covering element; it dispatches with
 * no modifiers, which would silently drop a Shift the Flow is holding. This
 * path reproduces that guarantee rather than giving it up.
 */
export const dispatchModifiedClick = (
  options: DispatchModifiedClickOptions
): Effect.Effect<void, BrowserRpcErrorType> => {
  if (!isVerifiableSelector(options.selector)) {
    return Effect.fail(
      inputError(
        `A click under a held modifier cannot verify the text selector ${options.selector}; use a CSS or XPath alternative.`
      )
    );
  }

  return withPageSession(
    options.cdpUrl,
    options.requestedTabId,
    (connection, sessionId) =>
      Effect.gen(function* clickWithModifiers() {
        const evaluation = yield* connection.send(
          "Runtime.evaluate",
          {
            expression: HIT_TEST.replace(
              "SELECTOR",
              JSON.stringify(options.selector)
            ),
            returnByValue: true,
          },
          sessionId
        );
        const value =
          isRecord(evaluation) && isRecord(evaluation.result)
            ? evaluation.result.value
            : undefined;
        if (!isRecord(value)) {
          return yield* Effect.fail(
            inputError(`Could not locate ${options.selector} to click.`)
          );
        }
        if (value.ok !== true) {
          return yield* Effect.fail(
            inputError(
              `${options.selector} ${asString(value.reason) ?? "cannot be clicked"}.`
            )
          );
        }
        const { x } = value;
        const { y } = value;
        if (typeof x !== "number" || typeof y !== "number") {
          return yield* Effect.fail(
            inputError(`Could not measure ${options.selector} to click.`)
          );
        }

        const modifiers = modifierMask(options.held);
        for (const type of ["mousePressed", "mouseReleased"] as const) {
          yield* connection.send(
            "Input.dispatchMouseEvent",
            { button: "left", clickCount: 1, modifiers, type, x, y },
            sessionId
          );
        }
      })
  );
};
