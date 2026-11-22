import {
  bindLayer,
  createChange,
  createFocusRecovery,
  definePrimitive,
  dispatch,
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

type HostSource = "anchor" | "root";

const activeElementIn = (doc: Document): Node | null => {
  let current: Element | null = doc.activeElement;
  while (current?.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement;
  }
  return current;
};

const composedContains = (container: Node, target: Node | null): boolean => {
  let current: Node | null = target;
  while (current !== null) {
    if (container.contains(current)) {
      return true;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
};

const isNodeWithinLayer = (
  el: HTMLElement,
  node: Node | null,
  contains: (target: Node) => boolean
): boolean => node !== null && (composedContains(el, node) || contains(node));

const eventTargetNode = (event: Event, doc: Document): Node | null => {
  const path = event.composedPath();
  if (path[0] instanceof Node) {
    return path[0];
  }
  if (event.target instanceof Node) {
    return event.target;
  }
  return activeElementIn(doc);
};

const definedDismissableLayer = definePrimitive({
  api: (context) => {
    const change = createChange(context);
    let previousFocus: HTMLElement | null = null;
    let hostEl: HTMLElement | null = null;
    let teardownHost: (() => void) | undefined;
    const hostSources = new Set<HostSource>();

    const captureFocus = (doc: Document) => {
      const active = activeElementIn(doc);
      previousFocus = active instanceof HTMLElement ? active : null;
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

    const contains = (target: Node): boolean =>
      context.options().contains?.(target) ?? false;

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

    const restoreFocus = () => {
      resolveRestoreTarget()?.focus();
    };

    const mountHost = (el: HTMLElement): (() => void) => {
      const doc = el.ownerDocument;
      let unbindLayer: (() => void) | undefined;
      let boundKey: string | undefined;
      let wasOpen = false;
      let disposed = false;
      let listeningFocus = false;
      let preboundByPointer = false;

      const attachLayer = () => {
        const state = context.store.get();
        if (!state.open || disposed) {
          return;
        }
        const nextKey = `${state.modal}:${state.topLayer}:${state.closeOnBlur}`;
        if (boundKey === nextKey && unbindLayer !== undefined) {
          return;
        }
        if (unbindLayer !== undefined) {
          unbindLayer();
        }
        boundKey = nextKey;
        unbindLayer = bindLayer(el, {
          closeOnBlur: state.closeOnBlur,
          contains,
          modal: state.modal,
          onDismiss: (reason, event) => close(reason, event),
          topLayer: state.topLayer,
        });
      };

      const detachLayer = () => {
        preboundByPointer = false;
        if (unbindLayer !== undefined) {
          unbindLayer();
          unbindLayer = undefined;
          boundKey = undefined;
        }
      };

      const onFocusIn = (event: FocusEvent) => {
        const target = eventTargetNode(event, doc);
        if (isNodeWithinLayer(el, target, contains)) {
          preboundByPointer = false;
          attachLayer();
        } else {
          detachLayer();
        }
      };

      const onFocusOut = (event: FocusEvent) => {
        const next =
          event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (isNodeWithinLayer(el, next, contains)) {
          return;
        }
        detachLayer();
      };

      // UI SDK Select and Menu open on pointerdown before mousedown moves focus;
      // pre-bind on capture so this layer registers beneath a nested popup opened
      // by clicking directly from outside, and undo on pointerup if focus did not enter.
      const onPointerDownCapture = (event: PointerEvent) => {
        if (unbindLayer !== undefined) {
          return;
        }
        if (isNodeWithinLayer(el, eventTargetNode(event, doc), contains)) {
          preboundByPointer = true;
          attachLayer();
        }
      };

      const onPointerEnd = () => {
        if (!preboundByPointer) {
          return;
        }
        preboundByPointer = false;
        if (!isNodeWithinLayer(el, activeElementIn(doc), contains)) {
          detachLayer();
        }
      };

      const attachFocusListeners = () => {
        if (listeningFocus) {
          return;
        }
        listeningFocus = true;
        doc.addEventListener("focusin", onFocusIn);
        doc.addEventListener("focusout", onFocusOut);
        doc.addEventListener("pointerdown", onPointerDownCapture, {
          capture: true,
        });
        doc.addEventListener("pointerup", onPointerEnd, { capture: true });
        doc.addEventListener("pointercancel", onPointerEnd, { capture: true });
      };

      const detachFocusListeners = () => {
        if (!listeningFocus) {
          return;
        }
        listeningFocus = false;
        preboundByPointer = false;
        doc.removeEventListener("focusin", onFocusIn);
        doc.removeEventListener("focusout", onFocusOut);
        doc.removeEventListener("pointerdown", onPointerDownCapture, {
          capture: true,
        });
        doc.removeEventListener("pointerup", onPointerEnd, { capture: true });
        doc.removeEventListener("pointercancel", onPointerEnd, {
          capture: true,
        });
      };

      const syncLayer = () => {
        const state = context.store.get();
        if (!state.open) {
          if (wasOpen) {
            wasOpen = false;
            const hadFocus = composedContains(el, activeElementIn(doc));
            detachFocusListeners();
            detachLayer();
            if (hadFocus) {
              restoreFocus();
            }
          }
          return;
        }
        if (!wasOpen) {
          wasOpen = true;
          captureFocus(doc);
        }
        if (state.scope === "focus-within") {
          attachFocusListeners();
          if (isNodeWithinLayer(el, activeElementIn(doc), contains)) {
            attachLayer();
          } else {
            detachLayer();
          }
          return;
        }
        detachFocusListeners();
        attachLayer();
      };

      syncLayer();
      const unsubscribe = context.store.subscribe(syncLayer);

      return () => {
        disposed = true;
        detachFocusListeners();
        unsubscribe();
        detachLayer();
      };
    };

    const bindHost = (source: HostSource, el: HTMLElement): (() => void) => {
      if (hostEl === el) {
        hostSources.add(source);
      } else {
        teardownHost?.();
        hostSources.clear();
        hostEl = el;
        hostSources.add(source);
        teardownHost = mountHost(el);
      }
      return () => {
        if (hostEl !== el) {
          return;
        }
        hostSources.delete(source);
        if (hostSources.size === 0) {
          teardownHost?.();
          teardownHost = undefined;
          hostEl = null;
        }
      };
    };

    return {
      bindHost,
      bindRecovery: (
        el: HTMLElement,
        part: { readonly key: string; readonly props: object }
      ) => recovery.bind(el, part),
      close,
      contains,
      dismiss: (reason: DismissableLayerDismissReason, event?: Event) =>
        close(reason, event),
      open: () => change("open", true, { reason: "imperative" }),
      restoreFocus,
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
    // Rendered as the root's first child so its ref attaches before sibling
    // descendants (such as a same-render defaultOpen Dialog) push onto UI SDK's stack.
    anchor: slot({
      attrs: () => ({
        "aria-hidden": "true",
        hidden: "",
      }),
      bind: (el, part) => {
        const root = el.parentElement;
        if (root === null) {
          return;
        }
        return part.api.bindHost("anchor", root);
      },
    }),
    root: slot({
      attrs: (state) => openAttrs(state.open),
      bind: (el, part) => {
        const unbindRecovery = part.api.bindRecovery(el, part);
        const unbindHost = part.api.bindHost("root", el);
        return () => {
          unbindHost();
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
