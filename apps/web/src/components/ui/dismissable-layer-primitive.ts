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
  readonly topLayer?: boolean | undefined;
}

export interface DismissableLayerRootState {
  readonly open: boolean;
}

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
    topLayer: "boolean",
  },
  slots: (slot) => ({
    root: slot({
      attrs: (state) => openAttrs(state.open),
      bind: (el, part) => {
        const unbindRecovery = part.api.bindRecovery(el, part);
        let unbindLayer: (() => void) | undefined;
        let boundKey: string | undefined;

        const syncLayer = () => {
          const state = part.store.get();
          if (state.open) {
            const nextKey = `${state.modal}:${state.topLayer}:${state.closeOnBlur}`;
            if (boundKey === nextKey && unbindLayer !== undefined) {
              return;
            }
            if (unbindLayer === undefined) {
              part.api.captureFocus(el.ownerDocument);
            } else {
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
            return;
          }
          if (unbindLayer !== undefined) {
            const hadFocus = el.contains(el.ownerDocument.activeElement);
            unbindLayer();
            unbindLayer = undefined;
            boundKey = undefined;
            if (hadFocus) {
              part.api.restoreFocus();
            }
          }
        };

        syncLayer();
        const unsubscribe = part.store.subscribe(syncLayer);

        return () => {
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
    topLayer: options.topLayer ?? false,
  }),
  sync: (options) => {
    const base = {
      closeOnBlur: options.closeOnBlur ?? false,
      modal: options.modal ?? false,
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
