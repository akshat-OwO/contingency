import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { FieldVariableCard } from "@/components/agent/native-field-variable";

afterEach(cleanup);

const renderCard = (
  props: Partial<Parameters<typeof FieldVariableCard>[0]> = {}
) => {
  const handlers = { onEnter: vi.fn(), onRequest: vi.fn(), onStop: vi.fn() };
  render(
    <FieldVariableCard
      disabled={false}
      field="Password"
      variables={[]}
      {...handlers}
      {...props}
    />
  );
  return {
    ...handlers,
    form: screen.getByRole("form", { name: "Field Variable" }),
  };
};

test("a password field takes a named Variable and never typed text", async () => {
  const user = userEvent.setup();
  const { form, onRequest } = renderCard();
  expect(
    within(form).getByRole("heading", {
      name: "Enter a Variable into Password",
    })
  ).toBeVisible();
  // The only text box names a Variable; there is no box for the value.
  expect(
    within(form)
      .getAllByRole("textbox")
      .map((box) => box.getAttribute("aria-label"))
  ).toEqual(["Variable name"]);
  const name = within(form).getByRole("textbox", { name: "Variable name" });
  await user.clear(name);
  await user.type(name, "shopper_pin{Enter}");
  expect(name).toHaveValue("SHOPPER_PIN");
  expect(onRequest).toHaveBeenLastCalledWith("SHOPPER_PIN");
});

test("a name that is not a Variable name cannot be requested", async () => {
  const user = userEvent.setup();
  const { form, onRequest } = renderCard();
  const name = within(form).getByRole("textbox", { name: "Variable name" });
  await user.clear(name);
  await user.type(name, "1PIN");
  expect(
    within(form).getByRole("button", { name: "Request Variable" })
  ).toBeDisabled();
  await user.type(name, "{Enter}");
  expect(onRequest).not.toHaveBeenCalled();
});

test("a supplied Variable is entered by reference and the rest wait", async () => {
  const user = userEvent.setup();
  const { form, onEnter, onStop } = renderCard({
    variables: [
      { name: "PASSWORD", status: "supplied" },
      { name: "OTP", status: "requested" },
    ],
  });
  await user.click(
    within(form).getByRole("button", { name: "Enter PASSWORD" })
  );
  expect(onEnter).toHaveBeenLastCalledWith("PASSWORD");
  expect(
    within(form).getByText("Waiting for OTP to be supplied.")
  ).toBeVisible();
  expect(within(form).queryByRole("button", { name: "Enter OTP" })).toBeNull();
  await user.click(within(form).getByRole("button", { name: "Stop typing" }));
  expect(onStop).toHaveBeenCalledOnce();
});

test("a busy session holds the card's actions", () => {
  const { form } = renderCard({
    disabled: true,
    variables: [{ name: "PASSWORD", status: "supplied" }],
  });
  expect(
    within(form).getByRole("button", { name: "Enter PASSWORD" })
  ).toBeDisabled();
  expect(
    within(form).getByRole("button", { name: "Request Variable" })
  ).toBeDisabled();
  expect(
    within(form).getByRole("button", { name: "Stop typing" })
  ).toBeEnabled();
});
