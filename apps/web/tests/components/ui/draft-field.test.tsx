import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkServer, mount, partAttrs } from "@ui-sdk/core/testing";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { DismissableLayer } from "@/components/ui/dismissable-layer";
import { DraftField, draftField } from "@/components/ui/draft-field";
import type { DraftFieldCancelDetails } from "@/components/ui/draft-field";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

let previousStrict: boolean | undefined;

beforeAll(() => {
  previousStrict = globalThis.__UI_SDK_STRICT__;
  globalThis.__UI_SDK_STRICT__ = true;
});

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrict;
});

afterEach(cleanup);

test("renders pure attributes on the server", () => {
  const html = checkServer(draftField, {}, "<root><input /></root>");
  expect(html).toContain('data-slot="draft-field"');

  const instance = draftField({});
  try {
    const root = instance.part("root", {});
    expect(partAttrs(root)).toEqual({ "data-slot": "draft-field" });
  } finally {
    instance.destroy();
  }
});

test("commits on Enter with enter-key reason and ignores IME composition and modified keys", async () => {
  const onCommit = vi.fn();
  const view = mount(
    draftField,
    { onCommit },
    '<root><input aria-label="Locale" value="de-DE" /></root>'
  );
  try {
    const input = view.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();

    const composingEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Enter",
    });
    input.dispatchEvent(composingEnter);
    expect(onCommit).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);

    // Safari reports isComposing: false with keyCode 229 on the confirming Enter.
    const safariEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      keyCode: 229,
    });
    input.dispatchEvent(safariEnter);
    expect(onCommit).not.toHaveBeenCalled();
    expect(safariEnter.defaultPrevented).toBe(false);

    const modifiedEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    });
    input.dispatchEvent(modifiedEnter);
    expect(onCommit).not.toHaveBeenCalled();
    expect(modifiedEnter.defaultPrevented).toBe(false);

    await view.keys("Enter");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      "de-DE",
      expect.objectContaining({
        reason: "enter-key",
        source: "keyboard",
      })
    );
    expect(onCommit.mock.calls[0]?.[1]?.event?.defaultPrevented).toBe(true);
  } finally {
    view.unmount();
  }
});

test("claims Escape only when onCancel accepts it, and ignores IME Escape", async () => {
  const onCancel = vi.fn();
  const cancelable = mount(
    draftField,
    { onCancel },
    '<root><input aria-label="Key" value="flag" /></root>'
  );
  try {
    const input = cancelable.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();

    const composingEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Escape",
    });
    input.dispatchEvent(composingEscape);
    expect(onCancel).not.toHaveBeenCalled();
    expect(composingEscape.defaultPrevented).toBe(false);

    await cancelable.keys("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "escape-key",
        source: "keyboard",
      })
    );
    expect(onCancel.mock.calls[0]?.[0]?.event?.defaultPrevented).toBe(true);
  } finally {
    cancelable.unmount();
  }

  const uncancellable = mount(
    draftField,
    { onCommit: vi.fn() },
    '<root><input aria-label="Locale" value="de-DE" /></root>'
  );
  try {
    const input = uncancellable.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();

    const escapeEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    input.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(false);
  } finally {
    uncancellable.unmount();
  }

  const declined = mount(
    draftField,
    {
      onCancel: (details: DraftFieldCancelDetails) => {
        details.cancel();
      },
    },
    '<root><input aria-label="Key" value="flag" /></root>'
  );
  try {
    const input = declined.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();

    const escapeEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    input.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(false);
  } finally {
    declined.unmount();
  }
});

test("commitOnBlur commits changed values once and skips unchanged or already-committed blurs", () => {
  const onCommit = vi.fn();
  const view = mount(
    draftField,
    { commitOnBlur: true, onCommit },
    '<root><input aria-label="Locale" value="" /></root>'
  );
  try {
    const input = view.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }

    // Focus and blur without editing does not commit.
    input.focus();
    input.blur();
    expect(onCommit).not.toHaveBeenCalled();

    // Edit then Enter commits once and leaves the field; a later blur adds nothing.
    input.focus();
    input.value = "de-DE";
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      })
    );
    expect(document.activeElement).not.toBe(input);
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(
      "de-DE",
      expect.objectContaining({ reason: "enter-key" })
    );

    // Refocus and blur unchanged does not commit again.
    input.focus();
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(1);

    // Clearing to empty and blurring commits the empty value with blur reason.
    input.focus();
    input.value = "";
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ reason: "blur" })
    );
  } finally {
    view.unmount();
  }
});

test("Enter on a blur-committed field commits, even unchanged, and leaves the field", () => {
  const onCommit = vi.fn();
  const view = mount(
    draftField,
    { commitOnBlur: true, onCommit },
    '<root><input aria-label="Locale" value="" /></root>'
  );
  try {
    const input = view.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();
    input.value = "fr-FR";
    const enterEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    input.dispatchEvent(enterEvent);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(
      "fr-FR",
      expect.objectContaining({ reason: "enter-key" })
    );

    // Enter in a blank, unchanged field still commits: it clears an override.
    // A passive blur of that unchanged field sends nothing.
    input.value = "";
    input.focus();
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(1);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      })
    );
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(
      "",
      expect.objectContaining({ reason: "enter-key" })
    );
  } finally {
    view.unmount();
  }
});

test("Enter on a blur-committed field dispatches once when the commit is empty or canceled", () => {
  const onEmptyCommit = vi.fn();
  const onCommit = vi.fn((_value: string, details: { cancel: () => void }) => {
    details.cancel();
  });
  const view = mount(
    draftField,
    { commitOnBlur: true, onCommit, onEmptyCommit },
    '<root><input aria-label="Locale" value="de-DE" /></root>'
  );
  try {
    const input = view.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    const enter = () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        })
      );

    // Clearing a filled draft and pressing Enter reports the empty commit once.
    input.focus();
    input.value = "";
    enter();
    expect(onEmptyCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    // A canceled Enter commit is not reapplied by the blur Enter causes.
    input.focus();
    input.value = "fr-FR";
    enter();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);

    // A separate blur of a new edit still commits.
    input.focus();
    input.value = "it-IT";
    input.blur();
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(
      "it-IT",
      expect.objectContaining({ reason: "blur" })
    );
  } finally {
    view.unmount();
  }
});

test("onEmptyCommit catches empty Enter and lets non-empty Enter pass through when onCommit is unset", async () => {
  const onEmptyCommit = vi.fn();
  const view = mount(
    draftField,
    { onEmptyCommit },
    '<root><input aria-label="Variable" value="" /></root>'
  );
  try {
    const input = view.root.querySelector("input");
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Expected input element");
    }
    input.focus();

    await view.keys("Enter");
    expect(onEmptyCommit).toHaveBeenCalledTimes(1);
    expect(onEmptyCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "enter-key",
        source: "keyboard",
      })
    );
    expect(onEmptyCommit.mock.calls[0]?.[0]?.event?.defaultPrevented).toBe(
      true
    );

    input.value = "secret";
    const filledEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    input.dispatchEvent(filledEnter);
    expect(onEmptyCommit).toHaveBeenCalledTimes(1);
    expect(filledEnter.defaultPrevented).toBe(false);
  } finally {
    view.unmount();
  }
});

test("ignores disabled inputs, readOnly inputs, and non-input children", () => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const view = mount(
    draftField,
    { commitOnBlur: true, onCancel, onCommit },
    '<root><input aria-label="Readonly" readonly value="x" /><button type="button">Clear</button></root>'
  );
  try {
    const input = view.root.querySelector("input");
    const button = view.root.querySelector("button");
    if (
      !(input instanceof HTMLInputElement) ||
      !(button instanceof HTMLButtonElement)
    ) {
      throw new Error("Expected input and button");
    }

    input.focus();
    const roEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    input.dispatchEvent(roEnter);
    expect(roEnter.defaultPrevented).toBe(false);
    input.blur();

    button.focus();
    const buttonEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    button.dispatchEvent(buttonEscape);
    expect(buttonEscape.defaultPrevented).toBe(false);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

test("React DraftField preserves Input data-slot, Field wiring, and native form submit", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();

  const Harness = () => {
    const [value, setValue] = useState("");
    const [invalid, setInvalid] = useState(false);
    return (
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <Field invalid={invalid}>
          <FieldLabel>Token</FieldLabel>
          <DraftField
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
            onEmptyCommit={() => setInvalid(true)}
            value={value}
          />
          {invalid ? <FieldError>Enter a value.</FieldError> : null}
        </Field>
        <button disabled={value === ""} type="submit">
          Supply
        </button>
      </form>
    );
  };

  render(<Harness />);
  const input = screen.getByRole("textbox", { name: "Token" });
  expect(input).toHaveAttribute("data-slot", "input");
  expect(input.closest('[data-slot="draft-field"]')).not.toBeNull();

  await user.click(input);
  await user.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("Enter a value.");

  await user.type(input, "abc");
  expect(input).not.toHaveAttribute("aria-invalid", "true");
  await user.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith("abc");
});

test("Escape cancels a cancelable DraftField before dismissing an enclosing DismissableLayer, and bubbles when uncancellable", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();

  const CancelableHarness = () => {
    const [cardOpen, setCardOpen] = useState(true);
    const [draftOpen, setDraftOpen] = useState(true);
    return cardOpen ? (
      <DismissableLayer
        onDismiss={() => {
          onDismiss();
          setCardOpen(false);
        }}
        render={<section aria-label="Inspector card" />}
      >
        {draftOpen ? (
          <DraftField
            aria-label="Draft key"
            defaultValue="temp"
            onCancel={() => setDraftOpen(false)}
          />
        ) : null}
      </DismissableLayer>
    ) : null;
  };

  const { unmount } = render(<CancelableHarness />);
  await user.click(screen.getByRole("textbox", { name: "Draft key" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Draft key" })).toBeNull();
  expect(
    screen.getByRole("region", { name: "Inspector card" })
  ).toBeInTheDocument();
  expect(onDismiss).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Inspector card" })).toBeNull();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  unmount();

  const onUncancellableDismiss = vi.fn();
  const UncancellableHarness = () => {
    const [cardOpen, setCardOpen] = useState(true);
    return cardOpen ? (
      <DismissableLayer
        onDismiss={() => {
          onUncancellableDismiss();
          setCardOpen(false);
        }}
        render={<section aria-label="Emulation card" />}
      >
        <DraftField
          aria-label="Locale"
          commitOnBlur
          defaultValue=""
          onCommit={vi.fn()}
        />
      </DismissableLayer>
    ) : null;
  };

  render(<UncancellableHarness />);
  await user.click(screen.getByRole("textbox", { name: "Locale" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Emulation card" })).toBeNull();
  expect(onUncancellableDismiss).toHaveBeenCalledTimes(1);
});

test("caller onKeyDown preventDefault skips DraftField commit", () => {
  const onCommit = vi.fn();
  render(
    <DraftField
      aria-label="Guarded"
      defaultValue="val"
      onCommit={onCommit}
      onKeyDown={(event) => {
        event.preventDefault();
      }}
    />
  );
  const input = screen.getByRole("textbox", { name: "Guarded" });
  input.focus();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onCommit).not.toHaveBeenCalled();
});
