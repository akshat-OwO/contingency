import { useEffect, useEffectEvent, useState } from "react";
import type { RefObject } from "react";

export type CommentShortcut = "compose" | "inspect";

export type ShortcutPlatform = "mac" | "other";

interface KeyLike {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

const CHORD_KEYS: Record<CommentShortcut, string> = {
  compose: "k",
  inspect: "c",
};

const BARE_KEYS: Record<CommentShortcut, string> = {
  compose: "/",
  inspect: "i",
};

export const shortcutPlatform = (): ShortcutPlatform =>
  /mac|iphone|ipad/iu.test(globalThis.navigator?.userAgent ?? "")
    ? "mac"
    : "other";

/**
 * The chord Contingency keeps for itself while the user is driving the Page:
 * the platform's primary modifier with Shift. Pages rarely bind either chord,
 * and `⌘⇧C` is the inspect chord browser DevTools already taught.
 */
export const chordShortcut = (
  event: KeyLike,
  platform: ShortcutPlatform
): CommentShortcut | undefined => {
  const primary = platform === "mac" ? event.metaKey : event.ctrlKey;
  const other = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (!primary || other || !event.shiftKey || event.altKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === CHORD_KEYS.compose) {
    return "compose";
  }
  return key === CHORD_KEYS.inspect ? "inspect" : undefined;
};

/** Single keys, offered only while focus is outside the Page. */
export const bareShortcut = (event: KeyLike): CommentShortcut | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === BARE_KEYS.compose) {
    return "compose";
  }
  return key === BARE_KEYS.inspect && !event.shiftKey ? "inspect" : undefined;
};

/** The keys a shortcut is pressed with, for `Kbd` labels. */
export const shortcutKeys = (
  shortcut: CommentShortcut,
  scope: "bare" | "chord",
  platform: ShortcutPlatform
): readonly string[] => {
  if (scope === "bare") {
    return [BARE_KEYS[shortcut].toUpperCase()];
  }
  const key = CHORD_KEYS[shortcut].toUpperCase();
  return platform === "mac" ? ["⌘", "⇧", key] : ["Ctrl", "Shift", key];
};

/** The `aria-keyshortcuts` value for both ways of pressing a shortcut. */
export const ariaKeyShortcuts = (
  shortcut: CommentShortcut,
  platform: ShortcutPlatform
) => {
  const primary = platform === "mac" ? "Meta" : "Control";
  return `${BARE_KEYS[shortcut]} ${primary}+Shift+${CHORD_KEYS[shortcut].toUpperCase()}`;
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement);

/** Whether the live browser canvas holds focus, so keys go to the Page. */
export const useElementFocused = (
  ref: RefObject<HTMLElement | null>
): boolean => {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const update = () => {
      setFocused(
        ref.current !== null && document.activeElement === ref.current
      );
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, [ref]);
  return focused;
};

/**
 * The one keyboard owner for commenting while recording.
 *
 * It listens in the capture phase, ahead of the canvas that forwards every key
 * to the Page, so it decides first and the Page never sees what it keeps:
 *
 * - The chords work everywhere. They are swallowed, keydown and keyup, so
 *   neither reaches the Page or the recording.
 * - `Escape` cancels a pick, even while the canvas holds focus.
 * - Single keys work only outside the Page and outside any field. With the
 *   canvas focused, `/` and `I` belong to the Page, as GitHub's search or a
 *   text field needs them to.
 */
export const useCommentShortcuts = ({
  browser,
  enabled,
  onCancelPick,
  onShortcut,
  picking,
}: {
  readonly browser: RefObject<HTMLElement | null>;
  readonly enabled: boolean;
  readonly onCancelPick: () => void;
  readonly onShortcut: (shortcut: CommentShortcut) => void;
  readonly picking: boolean;
}) => {
  const handleShortcut = useEffectEvent(onShortcut);
  const cancelPick = useEffectEvent(onCancelPick);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const platform = shortcutPlatform();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) {
        return;
      }
      const chord = chordShortcut(event, platform);
      if (chord !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          handleShortcut(chord);
        }
        return;
      }
      if (picking && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelPick();
        return;
      }
      const inPage =
        browser.current !== null && event.target === browser.current;
      if (inPage || isEditable(event.target) || event.repeat) {
        return;
      }
      const bare = bareShortcut(event);
      if (bare === undefined) {
        return;
      }
      /* A key typed into an open dialog or menu belongs to it. */
      if (
        event.target instanceof Element &&
        event.target.closest("[role=dialog], [role=menu], [role=listbox]") !==
          null
      ) {
        return;
      }
      event.preventDefault();
      handleShortcut(bare);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (chordShortcut(event, platform) !== undefined) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown, { capture: true });
    globalThis.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      globalThis.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      });
      globalThis.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
  }, [browser, enabled, picking]);
};
