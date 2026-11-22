import { definePrimitive } from "@ui-sdk/core";
import type { PrimitiveOptions, PropSpec } from "@ui-sdk/core";
import { Predicate } from "effect";

export type CopyButtonStatus = "idle" | "copied" | "failed";

export interface CopyButtonOptions extends PrimitiveOptions {
  readonly value: string;
}

export interface CopyButtonTriggerState {
  readonly copied: boolean;
  readonly failed: boolean;
  readonly status: CopyButtonStatus;
}

export interface CopyButtonFallbackState {
  readonly value: string;
}

interface CopyButtonState {
  readonly status: CopyButtonStatus;
  readonly value: string;
}

const COPIED_RESET_MS = 2000;

const statusAttrs = (status: CopyButtonStatus) => {
  if (status === "copied") {
    return { "data-copied": "", "data-status": status };
  }
  if (status === "failed") {
    return { "data-failed": "", "data-status": status };
  }
  return { "data-status": status };
};

const definedCopyButton = definePrimitive({
  api: (context) => {
    let attempt = 0;
    let currentValue = context.options().value;
    let destroyed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;

    const clearResetTimer = () => {
      if (resetTimer !== undefined) {
        clearTimeout(resetTimer);
        resetTimer = undefined;
      }
    };

    const markFailed = () => {
      context.store.set({ status: "failed" });
    };

    context.onOptions((options) => {
      if (options.value === currentValue) {
        return;
      }
      currentValue = options.value;
      attempt += 1;
      clearResetTimer();
      context.store.set({ status: "idle", value: options.value });
    });

    context.onDestroy(() => {
      destroyed = true;
      attempt += 1;
      clearResetTimer();
    });

    const copy = async (): Promise<boolean> => {
      if (destroyed) {
        return false;
      }
      attempt += 1;
      const currentAttempt = attempt;
      const { value } = context.options();
      clearResetTimer();

      const clipboard = globalThis.navigator?.clipboard;
      if (
        clipboard === undefined ||
        !Predicate.isFunction(clipboard.writeText)
      ) {
        markFailed();
        return false;
      }

      try {
        await clipboard.writeText(value);
      } catch {
        if (destroyed || currentAttempt !== attempt) {
          return false;
        }
        markFailed();
        return false;
      }

      if (destroyed || currentAttempt !== attempt) {
        return false;
      }

      context.store.set({ status: "copied" });
      resetTimer = setTimeout(() => {
        resetTimer = undefined;
        if (destroyed || currentAttempt !== attempt) {
          return;
        }
        context.store.set({ status: "idle" });
      }, COPIED_RESET_MS);
      return true;
    };

    return { copy };
  },
  controlled: [],
  name: "copy-button",
  options: {
    value: "string",
  },
  slots: (slot) => ({
    fallback: slot({
      attrs: () => ({}),
      present: (state) => state.status === "failed",
      state: (state): CopyButtonFallbackState => ({ value: state.value }),
    }),
    root: slot({
      attrs: (state) => statusAttrs(state.status),
    }),
    // A polite status inside the component, empty until a copy succeeds and
    // cleared by the reset, so the next copy is announced again.
    status: slot({
      attrs: () => ({ "aria-live": "polite", role: "status" }),
      state: (state): CopyButtonTriggerState => ({
        copied: state.status === "copied",
        failed: state.status === "failed",
        status: state.status,
      }),
    }),
    trigger: slot({
      attrs: (state) => ({
        ...statusAttrs(state.status),
        type: "button",
      }),
      press: ({ api }) => {
        // Clipboard write errors are handled inside `copy()` via `"failed"` state.
        void api.copy();
      },
      state: (state): CopyButtonTriggerState => ({
        copied: state.status === "copied",
        failed: state.status === "failed",
        status: state.status,
      }),
    }),
  }),
  state: (options: CopyButtonOptions): CopyButtonState => ({
    status: "idle",
    value: options.value,
  }),
});

// SAFETY: `@ui-sdk/core` 0.1.0-beta.5 types `definePrimitive`'s `options` as
// `Record<string, PropSpec> | undefined`, which clashes with `Primitive`'s
// `options?: Record<string, PropSpec>` under `exactOptionalPropertyTypes`.
// This definition supplies `options`, so it is always defined at runtime.
export const copyButton = definedCopyButton as typeof definedCopyButton & {
  readonly options: Record<string, PropSpec>;
};
