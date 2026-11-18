import type {
  AndroidWorkspaceObservation,
  NativeInput,
} from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { ScreenElements } from "@/components/agent/device-elements";
import { screenElementCount } from "@/components/agent/screen-elements";

afterEach(cleanup);

const node = (
  target: string,
  name: string,
  role: string,
  y: number,
  editable = false
) => ({
  bounds: { height: 40, width: 200, x: 0, y },
  covered: false,
  editable,
  name,
  password: false,
  role,
  target,
});

const observation: AndroidWorkspaceObservation = {
  capturedAt: "2026-11-05T00:00:00.000Z",
  height: 800,
  id: "observation-1",
  image: null,
  nodes: [
    node("clock", "9:13", "text", 0),
    // An app's own control can sit as high as the status bar.
    node("back", "Back", "button", 4),
    node("welcome", "Welcome back", "text", 120),
    node("heading", "Sign in", "group", 100),
    node("name", "Shopper name", "text-field", 200, true),
    node("submit", "Sign in", "button", 300),
    node("submit-text", "Sign in", "text", 300),
    node("first", "", "text-field", 400, true),
  ],
  width: 400,
};

const names = (heading: string) =>
  within(screen.getByRole("region", { name: heading }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

const renderElements = (
  props: Partial<Parameters<typeof ScreenElements>[0]> = {}
) =>
  render(
    <ScreenElements
      disabled={false}
      observation={observation}
      onActivate={vi.fn()}
      onHover={vi.fn()}
      {...props}
    />
  );

test("lists fields, then controls, then the rest, each label once", async () => {
  const user = userEvent.setup();
  renderElements();
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
  ).toEqual(["Fields", "Controls", "Other elements"]);
  expect(names("Fields")).toEqual([
    "Select Shopper name",
    "Select Unnamed field 1",
  ]);
  expect(names("Controls")).toEqual(["Activate Back", "Activate Sign in"]);
  // The rest waits behind its heading while fields and controls exist.
  const other = screen.getByRole("button", { name: "Other elements" });
  expect(other).toHaveAttribute("aria-expanded", "false");
  await user.click(other);
  // The button's own text and its heading repeat its label, so they are
  // left out, and so is the status bar's clock.
  expect(names("Other elements")).toEqual([null, "Activate Welcome back"]);
  // The rail's count is the same list's length.
  expect(screenElementCount(observation)).toBe(7);
});

test("activating an element taps the device at its centre", async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn<(inputs: readonly NativeInput[]) => void>();
  renderElements({ onActivate });
  await user.click(screen.getByRole("button", { name: "Activate Sign in" }));
  const taps = onActivate.mock.calls.at(-1)?.[0] ?? [];
  expect(
    taps.map((input) =>
      input._tag === "touch" ? `touch ${input.action}` : input._tag
    )
  ).toEqual(["touch down", "touch up"]);
});

test("the filter narrows the list by name or role and says when nothing matches", async () => {
  const user = userEvent.setup();
  renderElements();
  const filter = screen.getByRole("textbox", {
    name: "Filter screen elements",
  });
  await user.type(filter, "welcome");
  // A search shows every match, so Other elements no longer collapses.
  expect(names("Other elements")).toEqual(["Activate Welcome back"]);
  expect(screen.queryByRole("region", { name: "Fields" })).toBeNull();
  await user.clear(filter);
  await user.type(filter, "field");
  expect(names("Fields")).toEqual([
    "Select Shopper name",
    "Select Unnamed field 1",
  ]);
  await user.clear(filter);
  await user.type(filter, "checkout");
  expect(
    screen.getByText("Nothing on screen matches “checkout”.")
  ).toBeVisible();
});

test("hovering or focusing an element outlines it on the screen", async () => {
  const user = userEvent.setup();
  const onHover = vi.fn();
  renderElements({ onHover });
  await user.hover(screen.getByRole("button", { name: "Select Shopper name" }));
  expect(onHover).toHaveBeenLastCalledWith({
    height: 0.05,
    left: 0,
    top: 0.25,
    width: 0.5,
  });
  await user.unhover(
    screen.getByRole("button", { name: "Select Shopper name" })
  );
  expect(onHover).toHaveBeenLastCalledWith(null);
});

test("an empty screen says nothing reports an element", () => {
  renderElements({ observation: null });
  expect(
    screen.getByText("Nothing on this screen reports an element yet.")
  ).toBeVisible();
  expect(screenElementCount(null)).toBe(0);
});
