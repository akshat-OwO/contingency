import type { AndroidWorkspaceObservation } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { DeviceElements } from "@/components/agent/device-elements";

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

test("lists fields, then controls, then the rest, each label once", async () => {
  const user = userEvent.setup();
  render(
    <DeviceElements
      disabled={false}
      observation={observation}
      onPick={vi.fn()}
    />
  );
  await user.click(screen.getByRole("button", { name: "Screen elements" }));
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
  ).toEqual(["Fields", "Controls", "Other elements"]);
  expect(names("Fields")).toEqual([
    "Select Shopper name",
    "Select Unnamed field 1",
  ]);
  expect(names("Controls")).toEqual(["Activate Sign in"]);
  // The rest waits behind its heading while fields and controls exist.
  const other = screen.getByRole("button", { name: "Other elements" });
  expect(other).toHaveAttribute("aria-expanded", "false");
  await user.click(other);
  // The button's own text and its heading repeat its label, so they are
  // left out; the clock is not.
  expect(names("Other elements")).toEqual([null, "Activate 9:13"]);
});
