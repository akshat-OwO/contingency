import { createChange, definePrimitive, openAttrs } from "@ui-sdk/core";
import type { ChangeDetails, PrimitiveOptions, PropSpec } from "@ui-sdk/core";

export type IslandFoldChangeReason =
  | "collapse-trigger"
  | "expand-trigger"
  | "programmatic";

export type IslandFoldChangeDetails = ChangeDetails<IslandFoldChangeReason>;

export interface IslandFoldOptions extends PrimitiveOptions {
  readonly defaultOpen?: boolean | undefined;
  readonly onOpenChange?:
    | ((open: boolean, details: IslandFoldChangeDetails) => void)
    | undefined;
  readonly open?: boolean | undefined;
}

export interface IslandFoldState {
  readonly open: boolean;
}

type TriggerKind = "collapse" | "expand";

const activeElementIn = (doc: Document): Element | null => {
  let current: Element | null = doc.activeElement;
  while (current?.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement;
  }
  return current;
};

const definedIslandFold = definePrimitive({
  api: (context) => {
    const change = createChange(context);
    const triggers = new Map<TriggerKind, HTMLElement>();
    let focusedTrigger: TriggerKind | null = null;
    let handoffToken = 0;
    let pendingFocus: TriggerKind | null = null;
    let wasOpen = context.store.get().open;

    const armHandoff = (target: TriggerKind, expireOnMicrotask: boolean) => {
      handoffToken += 1;
      const token = handoffToken;
      pendingFocus = target;
      if (expireOnMicrotask) {
        queueMicrotask(() => {
          if (handoffToken === token) {
            pendingFocus = null;
          }
        });
      }
    };

    const clearHandoff = () => {
      handoffToken += 1;
      pendingFocus = null;
    };

    const isTriggerFocused = (kind: TriggerKind): boolean => {
      if (focusedTrigger === kind) {
        return true;
      }
      const el = triggers.get(kind);
      if (el === undefined || !el.isConnected) {
        return false;
      }
      return activeElementIn(el.ownerDocument) === el;
    };

    const focusIfPending = (kind: TriggerKind) => {
      if (pendingFocus !== kind) {
        return;
      }
      const el = triggers.get(kind);
      if (el === undefined || !el.isConnected) {
        return;
      }
      clearHandoff();
      el.focus();
    };

    const unsubscribe = context.store.subscribe(() => {
      const { open } = context.store.get();
      if (open === wasOpen) {
        return;
      }
      const prevOpen = wasOpen;
      wasOpen = open;
      const leaving: TriggerKind = prevOpen ? "collapse" : "expand";
      const target: TriggerKind = open ? "collapse" : "expand";
      if (pendingFocus === target) {
        armHandoff(target, true);
      } else if (pendingFocus === null && isTriggerFocused(leaving)) {
        armHandoff(target, true);
      } else {
        clearHandoff();
      }
      if (focusedTrigger === leaving) {
        focusedTrigger = null;
      }
      focusIfPending(target);
    });

    context.onDestroy(() => {
      unsubscribe();
      focusedTrigger = null;
      clearHandoff();
      triggers.clear();
    });

    const collapse = (event?: Event) => {
      if (!context.store.get().open) {
        return;
      }
      armHandoff("expand", false);
      const applied = change(
        "open",
        false,
        event === undefined
          ? { reason: "collapse-trigger" }
          : { event, reason: "collapse-trigger" }
      );
      if (!applied) {
        clearHandoff();
      }
    };

    const expand = (event?: Event) => {
      if (context.store.get().open) {
        return;
      }
      armHandoff("collapse", false);
      const applied = change(
        "open",
        true,
        event === undefined
          ? { reason: "expand-trigger" }
          : { event, reason: "expand-trigger" }
      );
      if (!applied) {
        clearHandoff();
      }
    };

    const setOpen = (open: boolean, event?: Event) => {
      if (context.store.get().open === open) {
        return;
      }
      change(
        "open",
        open,
        event === undefined
          ? { reason: "programmatic" }
          : { event, reason: "programmatic" }
      );
    };

    const toggle = (event?: Event) => {
      if (context.store.get().open) {
        collapse(event);
      } else {
        expand(event);
      }
    };

    const bindTrigger = (kind: TriggerKind, el: HTMLElement) => {
      triggers.set(kind, el);
      const onFocus = () => {
        focusedTrigger = kind;
      };
      const onBlur = () => {
        if (el.isConnected && focusedTrigger === kind) {
          focusedTrigger = null;
        }
      };
      el.addEventListener("focus", onFocus);
      el.addEventListener("blur", onBlur);
      if (activeElementIn(el.ownerDocument) === el) {
        focusedTrigger = kind;
      }
      focusIfPending(kind);
      return () => {
        el.removeEventListener("focus", onFocus);
        el.removeEventListener("blur", onBlur);
        if (triggers.get(kind) === el) {
          triggers.delete(kind);
        }
      };
    };

    return {
      bindTrigger,
      collapse,
      expand,
      setOpen,
      toggle,
    };
  },
  controlled: ["open"],
  name: "island-fold",
  options: {
    defaultOpen: "boolean",
    onOpenChange: "callback",
    open: "boolean",
  },
  slots: (slot) => ({
    "collapse-trigger": slot({
      attrs: (state, part) => ({
        ...openAttrs(state.open),
        "aria-controls": `${part.id}-content`,
        "aria-expanded": String(state.open),
        type: "button",
      }),
      bind: (el, part) => part.api.bindTrigger("collapse", el),
      present: (state) => state.open,
      press: ({ api }, event) => {
        api.collapse(event);
      },
      state: (state): IslandFoldState => ({ open: state.open }),
    }),
    content: slot({
      attrs: (state, part) => ({
        ...openAttrs(state.open),
        id: `${part.id}-content`,
      }),
      state: (state): IslandFoldState => ({ open: state.open }),
    }),
    "expand-trigger": slot({
      attrs: (state) => ({
        ...openAttrs(state.open),
        "aria-expanded": String(state.open),
        type: "button",
      }),
      bind: (el, part) => part.api.bindTrigger("expand", el),
      present: (state) => !state.open,
      press: ({ api }, event) => {
        api.expand(event);
      },
      state: (state): IslandFoldState => ({ open: state.open }),
    }),
    root: slot({
      attrs: (state) => openAttrs(state.open),
      state: (state): IslandFoldState => ({ open: state.open }),
    }),
  }),
  state: (options: IslandFoldOptions): IslandFoldState => ({
    open: options.open ?? options.defaultOpen ?? true,
  }),
  sync: (options) => (options.open === undefined ? {} : { open: options.open }),
});

// SAFETY: `@ui-sdk/core` 0.1.0-beta.5 types `definePrimitive`'s `options` as
// `Record<string, PropSpec> | undefined`, which clashes with `Primitive`'s
// `options?: Record<string, PropSpec>` under `exactOptionalPropertyTypes`.
// This definition supplies `options`, so it is always defined at runtime.
export const islandFold = definedIslandFold as typeof definedIslandFold & {
  readonly options: Record<string, PropSpec>;
};
