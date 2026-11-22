import {
  bindLayer,
  createFocusRecovery,
  definePrimitive,
  dispatch,
  openAttrs,
} from "@ui-sdk/core";
import type { ChangeDetails, PrimitiveOptions, PropSpec } from "@ui-sdk/core";

export type DismissableLayerDismissReason = "escape-key" | "outside-press";

export type DismissableLayerScope = "document" | "focus-within";

export type DismissableLayerDetails =
  ChangeDetails<DismissableLayerDismissReason>;

export interface DismissableLayerOptions extends PrimitiveOptions {
  readonly contains?: ((target: Node) => boolean) | undefined;
  readonly dismissOnOutsidePress?: boolean | undefined;
  readonly onDismiss?:
    | ((
        reason: DismissableLayerDismissReason,
        details: DismissableLayerDetails
      ) => void)
    | undefined;
  readonly open?: boolean | undefined;
  readonly restoreFocus?:
    | boolean
    | (() => HTMLElement | null | undefined)
    | undefined;
  readonly scope?: DismissableLayerScope | undefined;
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

const isOutsideFocusTarget = (node: Node, doc: Document): boolean =>
  node === doc || node === doc.body || node === doc.documentElement;

const isWithinFocusScope = (
  el: HTMLElement,
  node: Node | null,
  contains: (target: Node) => boolean
): boolean => {
  if (node === null || isOutsideFocusTarget(node, el.ownerDocument)) {
    return false;
  }
  return composedContains(el, node) || contains(node);
};

const eventTargetNode = (event: Event | undefined): Node | null => {
  if (event === undefined) {
    return null;
  }
  const path = event.composedPath();
  if (path[0] instanceof Node) {
    return path[0];
  }
  return event.target instanceof Node ? event.target : null;
};

const definedDismissableLayer = definePrimitive({
  api: (context) => {
    let previousFocus: HTMLElement | null = null;
    let hostEl: HTMLElement | null = null;
    let unbindLayer: (() => void) | undefined;
    let unsubscribeStore: (() => void) | undefined;
    let wasOpen = false;
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

    const restoreFocus = () => {
      resolveRestoreTarget()?.focus();
    };

    const dismiss = (
      reason: DismissableLayerDismissReason,
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
      // `bindLayer` calls `preventDefault()` on Escape before `onDismiss`; a
      // focus-scoped layer accepts consuming that Escape (the start card is the
      // bottom layer on the home page, so nothing beneath it loses Escape).
      if (
        reason === "escape-key" &&
        context.store.get().scope === "focus-within" &&
        hostEl !== null
      ) {
        const target = eventTargetNode(event);
        const active = activeElementIn(hostEl.ownerDocument);
        if (
          !isWithinFocusScope(hostEl, target, contains) &&
          !isWithinFocusScope(hostEl, active, contains)
        ) {
          return false;
        }
      }
      const canceled = dispatch(
        context,
        "onDismiss",
        reason,
        event === undefined ? { reason } : { event, reason }
      );
      if (canceled) {
        return false;
      }
      if (context.options().open === undefined) {
        context.store.set({ open: false });
      }
      return true;
    };

    const attachLayer = (el: HTMLElement) => {
      if (unbindLayer !== undefined) {
        return;
      }
      if (!wasOpen) {
        wasOpen = true;
        captureFocus(el.ownerDocument);
      }
      unbindLayer = bindLayer(el, {
        contains,
        onDismiss: (reason, event) => {
          if (reason === "window-blur") {
            return;
          }
          dismiss(reason, event);
        },
      });
    };

    const detachLayer = () => {
      if (unbindLayer !== undefined) {
        unbindLayer();
        unbindLayer = undefined;
      }
    };

    const syncLayer = () => {
      if (hostEl === null) {
        return;
      }
      if (!context.store.get().open) {
        if (wasOpen) {
          wasOpen = false;
          const hadFocus = composedContains(
            hostEl,
            activeElementIn(hostEl.ownerDocument)
          );
          detachLayer();
          if (hadFocus) {
            restoreFocus();
          }
        } else {
          detachLayer();
        }
        return;
      }
      attachLayer(hostEl);
    };

    const bindHost = (
      source: HostSource,
      el: HTMLElement,
      forceOpen: boolean
    ): (() => void) => {
      if (hostEl !== el) {
        unsubscribeStore?.();
        unsubscribeStore = undefined;
        detachLayer();
        hostSources.clear();
        wasOpen = false;
        hostEl = el;
        unsubscribeStore = context.store.subscribe(syncLayer);
      }
      hostSources.add(source);
      if (forceOpen || context.store.get().open) {
        attachLayer(el);
      }
      return () => {
        if (hostEl !== el) {
          return;
        }
        hostSources.delete(source);
        if (hostSources.size === 0) {
          unsubscribeStore?.();
          unsubscribeStore = undefined;
          detachLayer();
          wasOpen = false;
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
      contains,
      dismiss,
      restoreFocus,
    };
  },
  controlled: [],
  name: "dismissable-layer",
  options: {
    contains: "value",
    dismissOnOutsidePress: "boolean",
    onDismiss: "callback",
    open: "boolean",
    restoreFocus: "value",
    scope: "string",
  },
  slots: (slot) => ({
    // Rendered as the root's first child while open so its ref attaches before
    // sibling descendants push onto UI SDK's stack on both mount and reopen.
    anchor: slot<{ readonly open?: boolean | undefined }>({
      attrs: () => ({
        "aria-hidden": "true",
        hidden: "",
      }),
      bind: (el, part) => {
        const root = el.parentElement;
        if (root === null) {
          return;
        }
        return part.api.bindHost("anchor", root, part.props.open === true);
      },
      props: {
        open: "boolean",
      },
    }),
    root: slot({
      attrs: (state) => openAttrs(state.open),
      bind: (el, part) => {
        const unbindRecovery = part.api.bindRecovery(el, part);
        const unbindHost = part.api.bindHost("root", el, false);
        return () => {
          unbindHost();
          unbindRecovery();
        };
      },
      state: (state): DismissableLayerRootState => ({ open: state.open }),
    }),
  }),
  state: (options: DismissableLayerOptions) => ({
    open: options.open ?? true,
    scope: options.scope ?? "document",
  }),
  sync: (options) => {
    const base = {
      scope: options.scope ?? "document",
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
