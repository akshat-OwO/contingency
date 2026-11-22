import { createChange, definePrimitive } from "@ui-sdk/core";
import type {
  ChangeDetails,
  ChangeSource,
  PrimitiveOptions,
  PropSpec,
} from "@ui-sdk/core";
import type { PopoverOpenChangeReason } from "@ui-sdk/core/popover";

/**
 * Why the dialog opened or closed. `"arrow-key"` is the combobox's own
 * ArrowDown or ArrowUp; the rest come from the Popover it renders.
 */
export type DialogComboboxOpenChangeReason =
  | "arrow-key"
  | PopoverOpenChangeReason;

export type DialogComboboxOpenChangeDetails =
  ChangeDetails<DialogComboboxOpenChangeReason>;

export interface DialogComboboxOptions extends PrimitiveOptions {
  readonly defaultOpen?: boolean | undefined;
  readonly onOpenChange?:
    | ((open: boolean, details: DialogComboboxOpenChangeDetails) => void)
    | undefined;
  readonly open?: boolean | undefined;
}

/** What a Popover's `onOpenChange` reports, forwarded into the combobox. */
export interface DialogComboboxChange {
  readonly event?: Event | undefined;
  readonly reason: DialogComboboxOpenChangeReason;
  readonly source?: ChangeSource | undefined;
}

export interface DialogComboboxState {
  readonly open: boolean;
}

const definedDialogCombobox = definePrimitive({
  api: (context) => {
    const change = createChange(context);
    const setOpen = (
      open: boolean,
      { event, reason, source }: DialogComboboxChange
    ) => {
      // Set only what's known: `createChange` takes no `undefined` fields.
      const details: Parameters<typeof change>[2] = { reason };
      if (event !== undefined) {
        details.event = event;
      }
      if (source !== undefined) {
        details.source = source;
      }
      return change("open", open, details);
    };
    return { setOpen };
  },
  controlled: ["open"],
  name: "dialog-combobox",
  options: {
    defaultOpen: "boolean",
    onOpenChange: "callback",
    open: "boolean",
  },
  slots: (slot) => ({
    // Renders no element of its own: its React part hands `open` to the
    // Popover it composes.
    root: slot({
      state: (state): DialogComboboxState => ({ open: state.open }),
    }),
    // A combobox that opens a dialog rather than a listbox. The Popover
    // trigger it renders presses it open and owns `aria-controls`.
    trigger: slot({
      attrs: (state) => ({
        "aria-expanded": String(state.open),
        "aria-haspopup": "dialog",
      }),
      focus: "native",
      keys: ["ArrowDown", "ArrowUp"],
      on: {
        keydown: (event, { api }) => {
          if (
            !(event instanceof KeyboardEvent) ||
            (event.key !== "ArrowDown" && event.key !== "ArrowUp")
          ) {
            return;
          }
          event.preventDefault();
          api.setOpen(true, { event, reason: "arrow-key" });
        },
      },
      press: { none: "The Popover trigger it renders presses it open." },
      role: "combobox",
      state: (state): DialogComboboxState => ({ open: state.open }),
    }),
  }),
  state: (options: DialogComboboxOptions) => ({
    open: options.open ?? options.defaultOpen ?? false,
  }),
  sync: (options) => (options.open === undefined ? {} : { open: options.open }),
});

// SAFETY: `@ui-sdk/core` 0.1.0-beta.5 types `definePrimitive`'s `options` as
// `Record<string, PropSpec> | undefined`, which clashes with `Primitive`'s
// `options?: Record<string, PropSpec>` under `exactOptionalPropertyTypes`.
// This definition supplies `options`, so it is always defined at runtime.
export const dialogCombobox =
  definedDialogCombobox as typeof definedDialogCombobox & {
    readonly options: Record<string, PropSpec>;
  };
