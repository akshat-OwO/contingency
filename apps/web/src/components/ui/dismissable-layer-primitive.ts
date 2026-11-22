import {
  bindLayer,
  createChange,
  createFocusRecovery,
  definePrimitive,
  dispatch,
  isComposing,
  isDismissal,
  openAttrs,
} from "@ui-sdk/core";
import type {
  ChangeDetails,
  LayerDismissReason,
  PrimitiveOptions,
  PropSpec,
} from "@ui-sdk/core";

export type DismissableLayerDismissReason = LayerDismissReason;

export type DismissableLayerCloseReason = LayerDismissReason | "imperative";

export type DismissableLayerScope = "document" | "focus-within";

export type DismissableLayerDetails =
  ChangeDetails<DismissableLayerDismissReason>;

export type DismissableLayerOpenChangeDetails =
  ChangeDetails<DismissableLayerCloseReason>;

export interface DismissableLayerOptions extends PrimitiveOptions {
  readonly closeOnBlur?: boolean | undefined;
  readonly contains?: ((target: Node) => boolean) | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly dismissOnOutsidePress?: boolean | undefined;
  readonly modal?: boolean | undefined;
  readonly onDismiss?:
    | ((
        reason: DismissableLayerDismissReason,
        details: DismissableLayerDetails
      ) => void)
    | undefined;
  readonly onOpenChange?:
    | ((open: boolean, details: DismissableLayerOpenChangeDetails) => void)
    | undefined;
  readonly open?: boolean | undefined;
  readonly restoreFocus?:
    | boolean
    | (() => HTMLElement | null | undefined)
    | undefined;
  readonly scope?: DismissableLayerScope | undefined;
  readonly topLayer?: boolean | undefined;
}

export interface DismissableLayerRootState {
  readonly open: boolean;
}

const OPEN_POPUP_DESCENDANT_SELECTOR =
  '[popover][data-open], [popover]:not([hidden]) > [data-open][data-presentation="sheet"]';
const OPEN_DISMISSABLE_LAYER_SELECTOR =
  '[data-slot="dismissable-layer"][data-open]';

const layerAcceptsEscape = new WeakMap<
  HTMLElement,
  (event: KeyboardEvent) => boolean
>();

const isNodeWithinLayer = (
  el: HTMLElement,
  node: Node | null,
  contains: (target: Node) => boolean
): boolean => node !== null && (el.contains(node) || contains(node));

const isEscapeWithinLayer = (
  el: HTMLElement,
  event: KeyboardEvent,
  contains: (target: Node) => boolean
): boolean => {
  const doc = el.ownerDocument;
  const path = event.composedPath();
  const target = path[0] instanceof Node ? path[0] : event.target;
  if (
    target instanceof Node &&
    target !== doc &&
    target !== doc.body &&
    target !== doc.documentElement
  ) {
    return path.length > 0
      ? path.some(
          (hop) => hop instanceof Node && isNodeWithinLayer(el, hop, contains)
        )
      : isNodeWithinLayer(el, target, contains);
  }
  return isNodeWithinLayer(el, doc.activeElement, contains);
};

const hasOpenDescendantLayer = (
  el: HTMLElement,
  event: KeyboardEvent
): boolean => {
  if (el.querySelector(OPEN_POPUP_DESCENDANT_SELECTOR) !== null) {
    return true;
  }
  for (const child of el.querySelectorAll(OPEN_DISMISSABLE_LAYER_SELECTOR)) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    const accepts = layerAcceptsEscape.get(child);
    if (accepts === undefined || accepts(event)) {
      return true;
    }
  }
  return false;
};

const definedDismissableLayer = definePrimitive({
  api: (context) => {
    const change = createChange(context);
    let previousFocus: HTMLElement | null = null;

    const captureFocus = (doc: Document) => {
      previousFocus =
        doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    };

    const resolveRestoreTarget = (): HTMLElement | undefined => {
      const option = context.options().restoreFocus;
      if (option === undefined || option === false) {
        return undefined;
      }
      if (option === true) {
        return previousFocus?.isConnected ? previousFocus : undefined;
      }
      const target = option();
      return target?.isConnected ? target : undefined;
    };

    const recovery = createFocusRecovery({
      fallback: () =>
        context.store.get().open ? resolveRestoreTarget() : undefined,
    });

    const close = (
      reason: DismissableLayerCloseReason = "imperative",
      event?: Event
    ): boolean => {
      if (!context.store.get().open) {
        return false;
      }
      if (
        reason === "outside-press" &&
        !context.options().dismissOnOutsidePress
      ) {
        return false;
      }
      if (isDismissal(reason)) {
        const canceled = dispatch(
          context,
          "onDismiss",
          reason,
          event === undefined ? { reason } : { event, reason }
        );
        if (canceled) {
          return false;
        }
      }
      const options = context.options();
      // Controlled callers that handle dismissal via `onDismiss` alone omit
      // `onOpenChange`; skip `change` there to avoid controlled-without-handler
      // warnings while still updating uncontrolled state and firing `onOpenChange`.
      if (options.open !== undefined && options.onOpenChange === undefined) {
        return true;
      }
      return change(
        "open",
        false,
        event === undefined ? { reason } : { event, reason }
      );
    };

    return {
      bindRecovery: (
        el: HTMLElement,
        part: { readonly key: string; readonly props: object }
      ) => recovery.bind(el, part),
      captureFocus,
      close,
      contains: (target: Node) => context.options().contains?.(target) ?? false,
      dismiss: (reason: DismissableLayerDismissReason, event?: Event) =>
        close(reason, event),
      open: () => change("open", true, { reason: "imperative" }),
      restoreFocus: () => {
        resolveRestoreTarget()?.focus();
      },
    };
  },
  controlled: ["open"],
  name: "dismissable-layer",
  options: {
    closeOnBlur: "boolean",
    contains: "value",
    defaultOpen: "boolean",
    dismissOnOutsidePress: "boolean",
    modal: "boolean",
    onDismiss: "callback",
    onOpenChange: "callback",
    open: "boolean",
    restoreFocus: "value",
    scope: "string",
    topLayer: "boolean",
  },
  slots: (slot) => ({
    root: slot({
      attrs: (state) => openAttrs(state.open),
      bind: (el, part) => {
        const unbindRecovery = part.api.bindRecovery(el, part);
        const doc = el.ownerDocument;
        const win = doc.defaultView;
        let unbindLayer: (() => void) | undefined;
        let boundKey: string | undefined;
        let wasOpen = false;
        let disposed = false;
        let yielding = false;
        let cancelRestore: (() => void) | undefined;

        const acceptsEscape = (event: KeyboardEvent): boolean =>
          part.store.get().scope !== "focus-within" ||
          isEscapeWithinLayer(el, event, part.api.contains);

        layerAcceptsEscape.set(el, acceptsEscape);

        const attachLayer = (capturePreviousFocus: boolean) => {
          const state = part.store.get();
          if (!state.open || disposed || yielding) {
            return;
          }
          const nextKey = `${state.modal}:${state.topLayer}:${state.closeOnBlur}`;
          if (boundKey === nextKey && unbindLayer !== undefined) {
            return;
          }
          if (capturePreviousFocus) {
            part.api.captureFocus(doc);
          }
          if (unbindLayer !== undefined) {
            unbindLayer();
          }
          boundKey = nextKey;
          unbindLayer = bindLayer(el, {
            closeOnBlur: state.closeOnBlur,
            contains: (target) => part.api.contains(target),
            modal: state.modal,
            onDismiss: (reason, event) => part.api.dismiss(reason, event),
            topLayer: state.topLayer,
          });
        };

        const syncLayer = () => {
          const state = part.store.get();
          if (state.open) {
            const opening = !wasOpen;
            wasOpen = true;
            attachLayer(opening);
            return;
          }
          wasOpen = false;
          cancelRestore?.();
          cancelRestore = undefined;
          yielding = false;
          if (unbindLayer !== undefined) {
            const hadFocus = el.contains(doc.activeElement);
            unbindLayer();
            unbindLayer = undefined;
            boundKey = undefined;
            if (hadFocus) {
              part.api.restoreFocus();
            }
          }
        };

        // UI SDK's layer stack (`layers.js`) is append-only and dispatches Escape
        // only to its top active layer on `document` bubble, where `bindLayer`
        // calls `preventDefault()` before `onDismiss`. Pop temporarily during
        // window capture so same-render open children (bound before this parent
        // ref) or outside `focus-within` Escapes fall through untouched.
        const onKeyDownCapture = (event: KeyboardEvent) => {
          if (
            unbindLayer === undefined ||
            event.key !== "Escape" ||
            event.defaultPrevented ||
            isComposing(event)
          ) {
            return;
          }
          const shouldYield =
            !acceptsEscape(event) || hasOpenDescendantLayer(el, event);
          if (!shouldYield) {
            return;
          }
          yielding = true;
          const prevUnbind = unbindLayer;
          unbindLayer = undefined;
          boundKey = undefined;
          prevUnbind();

          let restored = false;
          let restoreTimer: ReturnType<typeof setTimeout> | undefined;
          const restore = () => {
            if (restored) {
              return;
            }
            restored = true;
            cancelRestore = undefined;
            if (restoreTimer !== undefined) {
              clearTimeout(restoreTimer);
              restoreTimer = undefined;
            }
            win?.removeEventListener("keydown", restore);
            yielding = false;
            if (!disposed) {
              attachLayer(false);
            }
          };
          cancelRestore = () => {
            if (restored) {
              return;
            }
            restored = true;
            if (restoreTimer !== undefined) {
              clearTimeout(restoreTimer);
              restoreTimer = undefined;
            }
            win?.removeEventListener("keydown", restore);
          };
          // Restore on window bubble (after document bubble finishes) with a
          // macrotask fallback if propagation stops. Never use queueMicrotask:
          // real browsers flush microtasks between capture and bubble listeners
          // on native events.
          win?.addEventListener("keydown", restore, { once: true });
          restoreTimer = setTimeout(restore, 0);
        };

        if (win === null) {
          doc.addEventListener("keydown", onKeyDownCapture, { capture: true });
        } else {
          win.addEventListener("keydown", onKeyDownCapture, { capture: true });
        }

        syncLayer();
        const unsubscribe = part.store.subscribe(syncLayer);

        return () => {
          disposed = true;
          cancelRestore?.();
          cancelRestore = undefined;
          yielding = false;
          if (win === null) {
            doc.removeEventListener("keydown", onKeyDownCapture, {
              capture: true,
            });
          } else {
            win.removeEventListener("keydown", onKeyDownCapture, {
              capture: true,
            });
          }
          layerAcceptsEscape.delete(el);
          unsubscribe();
          unbindLayer?.();
          unbindLayer = undefined;
          boundKey = undefined;
          unbindRecovery();
        };
      },
      state: (state): DismissableLayerRootState => ({ open: state.open }),
    }),
  }),
  state: (options: DismissableLayerOptions) => ({
    closeOnBlur: options.closeOnBlur ?? false,
    modal: options.modal ?? false,
    open: options.open ?? options.defaultOpen ?? true,
    scope: options.scope ?? "document",
    topLayer: options.topLayer ?? false,
  }),
  sync: (options) => {
    const base = {
      closeOnBlur: options.closeOnBlur ?? false,
      modal: options.modal ?? false,
      scope: options.scope ?? "document",
      topLayer: options.topLayer ?? false,
    };
    return options.open === undefined ? base : { ...base, open: options.open };
  },
});

// SAFETY: `@ui-sdk/core` 0.1.0-beta.5 types `definePrimitive`'s `options` as
// `Record<string, PropSpec> | undefined`, which clashes with `Primitive`'s
// `options?: Record<string, PropSpec>` under `exactOptionalPropertyTypes`.
// This definition supplies `options`, so it is always defined at runtime.
export const dismissableLayer =
  definedDismissableLayer as typeof definedDismissableLayer & {
    readonly options: Record<string, PropSpec>;
  };
