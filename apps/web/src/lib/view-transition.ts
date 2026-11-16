import { flushSync } from "react-dom";

/** Whether the person asked for less motion. Missing `matchMedia` means no. */
export const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Whether this browser can morph one view into the next. */
export const canViewTransition = (): boolean =>
  "startViewTransition" in document && !prefersReducedMotion();

/**
 * Gives `element` a view transition name before the old frame is taken. A
 * name may be on screen only once, so whatever held it in the last transition
 * gives it up to the element growing now.
 */
export const nameForTransition = (
  element: Element | null,
  name: string
): void => {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  for (const holder of document.querySelectorAll<HTMLElement>(
    `[data-vt="${name}"]`
  )) {
    if (holder !== element) {
      holder.style.viewTransitionName = "none";
    }
  }
  element.style.viewTransitionName = name;
};

/**
 * Moves the Workspace between views inside a View Transition. `morph` names
 * the element that grows into the next view before the old frame is taken, so
 * the browser pairs it with the element carrying that name afterwards. The
 * update runs synchronously inside the transition so the new frame is the
 * new view. Without View Transitions, or with reduced motion, it just runs.
 */
export const startWorkspaceTransition = (
  update: () => void,
  morph?: { readonly element: Element | null; readonly name: string }
): void => {
  if (!canViewTransition()) {
    update();
    return;
  }
  if (morph !== undefined) {
    nameForTransition(morph.element, morph.name);
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
};
