import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";

import { SegmentedControl } from "@/components/browser/segmented-control";

afterEach(cleanup);

const Scheme = () => {
  const [value, setValue] = useState<"dark" | "light" | "none">("none");
  return (
    <SegmentedControl
      label="Colour scheme"
      onChange={setValue}
      options={[
        { label: "No preference", value: "none" },
        { label: "Light", value: "light" },
        { label: "Dark", value: "dark" },
      ]}
      value={value}
    />
  );
};

test("is one tab stop whose arrows move and check the option", async () => {
  render(<Scheme />);
  const user = userEvent.setup();

  await user.tab();
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
  expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "tabindex",
    "-1"
  );
  await user.keyboard("{ArrowRight}");
  const light = screen.getByRole("radio", { name: "Light" });
  expect(light).toHaveFocus();
  expect(light).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{End}");
  expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
});
