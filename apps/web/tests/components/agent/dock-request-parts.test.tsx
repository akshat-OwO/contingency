import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  AnsweredVariables,
  VariableField,
} from "@/components/agent/dock-request-parts";

afterEach(cleanup);

const Field = ({
  onRefuse,
  onSubmit,
  masked = false,
}: {
  readonly onRefuse?: () => void;
  readonly onSubmit: () => void;
  readonly masked?: boolean;
}) => {
  const [value, setValue] = useState("");
  return (
    <VariableField
      error={undefined}
      id="field"
      label="PASSWORD"
      onRefuse={onRefuse}
      onSubmit={onSubmit}
      onValueChange={setValue}
      pending={false}
      private={masked}
      refuseLabel="Refuse PASSWORD"
      supplyLabel="Supply PASSWORD"
      value={value}
    />
  );
};

test("an empty value is marked instead of sent", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn<() => void>();
  render(<Field onRefuse={vi.fn<() => void>()} onSubmit={onSubmit} />);
  const field = screen.getByLabelText("PASSWORD");
  await user.click(field);
  await user.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field).toHaveAccessibleDescription("Enter a value, or refuse it.");
  await user.type(field, "x");
  expect(field).not.toHaveAttribute("aria-invalid");
  await user.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledOnce();
});

test("a value that can only be supplied asks only for a value", async () => {
  const user = userEvent.setup();
  render(<Field onSubmit={vi.fn<() => void>()} />);
  await user.click(screen.getByLabelText("PASSWORD"));
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("PASSWORD")).toHaveAccessibleDescription(
    "Enter a value."
  );
  expect(screen.queryByRole("button", { name: "Refuse PASSWORD" })).toBeNull();
});

test("a private value is masked until shown", async () => {
  const user = userEvent.setup();
  render(<Field masked onSubmit={vi.fn<() => void>()} />);
  const field = screen.getByLabelText("PASSWORD");
  expect(field).toHaveAttribute("type", "password");
  expect(screen.queryByRole("textbox")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show PASSWORD" }));
  expect(field).toHaveAttribute("type", "text");
  const hide = screen.getByRole("button", { name: "Hide PASSWORD" });
  expect(hide).toHaveAttribute("aria-pressed", "true");
  await user.click(hide);
  expect(field).toHaveAttribute("type", "password");
});

test("a value visible in evidence is typed in the clear", () => {
  render(<Field onSubmit={vi.fn<() => void>()} />);
  expect(screen.getByRole("textbox", { name: "PASSWORD" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Show /u })).toBeNull();
});

test("answered Variables say what happened, never the value", () => {
  render(
    <AnsweredVariables
      answers={[
        { key: "a", label: "STORE_EMAIL", status: "supplied" },
        { key: "b", label: "login/OTP", status: "refused" },
      ]}
    />
  );
  const items = within(
    screen.getByRole("list", { name: "Answered" })
  ).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "STORE_EMAIL supplied",
    "login/OTP refused",
  ]);
});
