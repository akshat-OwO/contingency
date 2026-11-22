import { definePrimitive, dispatch, isComposing } from "@ui-sdk/core";
import type { ChangeDetails, PrimitiveOptions, PropSpec } from "@ui-sdk/core";

export type DraftFieldCommitReason = "blur" | "enter-key";

export type DraftFieldCancelReason = "escape-key";

export type DraftFieldCommitDetails = ChangeDetails<DraftFieldCommitReason>;

export type DraftFieldCancelDetails = ChangeDetails<DraftFieldCancelReason>;

export interface DraftFieldOptions extends PrimitiveOptions {
  readonly commitOnBlur?: boolean | undefined;
  readonly onCancel?: ((details: DraftFieldCancelDetails) => void) | undefined;
  readonly onCommit?:
    | ((value: string, details: DraftFieldCommitDetails) => void)
    | undefined;
  readonly onEmptyCommit?:
    | ((details: DraftFieldCommitDetails) => void)
    | undefined;
}

const isDraftInput = (target: EventTarget | null): target is HTMLInputElement =>
  target instanceof HTMLInputElement && !target.disabled && !target.readOnly;

const hasModifier = (event: KeyboardEvent): boolean =>
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

const definedDraftField = definePrimitive({
  api: (context) => {
    let baseline: string | undefined;

    const dispatchDetail = <Reason extends string>(
      name: `on${string}`,
      listener: ((details: ChangeDetails<Reason>) => void) | undefined,
      reason: Reason,
      event?: Event
    ): boolean => {
      if (listener === undefined) {
        return false;
      }
      const options = context.options();
      const canceled = dispatch(
        {
          ...context,
          options: () => ({
            ...options,
            [name]: (_value: undefined, details: ChangeDetails<Reason>) => {
              listener(details);
            },
          }),
        },
        name,
        undefined,
        event === undefined ? { reason } : { event, reason }
      );
      return !canceled;
    };

    const commit = (
      value: string,
      reason: DraftFieldCommitReason,
      event?: Event
    ): boolean => {
      const options = context.options();
      if (value === "" && options.onEmptyCommit !== undefined) {
        return dispatchDetail(
          "onEmptyCommit",
          options.onEmptyCommit,
          reason,
          event
        );
      }
      if (options.onCommit === undefined) {
        return false;
      }
      const canceled = dispatch(
        context,
        "onCommit",
        value,
        event === undefined ? { reason } : { event, reason }
      );
      if (canceled) {
        return false;
      }
      baseline = value;
      return true;
    };

    const cancel = (event?: Event): boolean =>
      dispatchDetail(
        "onCancel",
        context.options().onCancel,
        "escape-key",
        event
      );

    const focusin = (event: FocusEvent) => {
      if (isDraftInput(event.target)) {
        baseline = event.target.value;
      }
    };

    const focusout = (event: FocusEvent) => {
      if (!context.options().commitOnBlur || !isDraftInput(event.target)) {
        return;
      }
      if (baseline !== undefined && event.target.value === baseline) {
        return;
      }
      commit(event.target.value, "blur", event);
    };

    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isComposing(event) ||
        hasModifier(event) ||
        !isDraftInput(event.target)
      ) {
        return;
      }
      if (event.key === "Enter") {
        // Enter always commits, even unchanged: in a blank Emulation field it
        // is how a person clears an applied override. A blur-committed field
        // then leaves the field; the commit set the baseline, so that blur
        // doesn't apply the same value again.
        if (context.options().commitOnBlur) {
          commit(event.target.value, "enter-key", event);
          event.preventDefault();
          event.target.blur();
          return;
        }
        if (commit(event.target.value, "enter-key", event)) {
          event.preventDefault();
        }
        return;
      }
      if (event.key === "Escape" && cancel(event)) {
        event.preventDefault();
      }
    };

    return {
      cancel,
      commit,
      focusin,
      focusout,
      keydown,
    };
  },
  controlled: [],
  name: "draft-field",
  options: {
    commitOnBlur: "boolean",
    onCancel: "callback",
    onCommit: "callback",
    onEmptyCommit: "callback",
  },
  slots: (slot) => ({
    root: slot({
      on: {
        focusin: (event, { api }) => {
          api.focusin(event);
        },
        focusout: (event, { api }) => {
          api.focusout(event);
        },
        keydown: (event, { api }) => {
          api.keydown(event);
        },
      },
    }),
  }),
  state: (_options: DraftFieldOptions) => ({}),
});

// SAFETY: `@ui-sdk/core` 0.1.0-beta.5 types `definePrimitive`'s `options` as
// `Record<string, PropSpec> | undefined`, which clashes with `Primitive`'s
// `options?: Record<string, PropSpec>` under `exactOptionalPropertyTypes`.
// This definition supplies `options`, so it is always defined at runtime.
export const draftField = definedDraftField as typeof definedDraftField & {
  readonly options: Record<string, PropSpec>;
};
