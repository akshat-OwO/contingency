import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type {
  DeviceChoice,
  DeviceStart,
} from "@/components/agent/device-choice-state";
import { DeviceChoices } from "@/components/agent/device-choices";
import { iosDeviceChoice } from "@/components/agent/ios-setup-state";

afterEach(cleanup);

const ready: DeviceChoice = {
  detail: "iOS 27.1",
  id: "ready",
  kind: "Simulator",
  name: "iPhone 17",
  status: { _tag: "ready" },
};
const stopped = (name: string): DeviceChoice => ({
  bootId: name,
  detail: "iOS 26.5",
  id: name,
  kind: "Simulator",
  name,
  status: { _tag: "stopped" },
});

const renderChoices = (
  devices: readonly DeviceChoice[],
  starts: Readonly<Record<string, DeviceStart>> = {},
  selected: string | null = null
) => {
  const onRefresh = vi.fn();
  const onSelect = vi.fn();
  const onStart = vi.fn();
  render(
    <DeviceChoices
      devices={devices}
      emptyMessage="Nothing exists."
      label="Simulator"
      onRefresh={onRefresh}
      onSelect={onSelect}
      onStart={onStart}
      selected={selected}
      starts={starts}
    />
  );
  return { onRefresh, onSelect, onStart };
};

const field = () => screen.getByRole("combobox", { name: "Simulator" });

test("a ready device is chosen from the Select", async () => {
  const user = userEvent.setup();
  const { onSelect } = renderChoices([ready]);
  await user.click(field());
  await user.click(await screen.findByRole("option", { name: /iPhone 17/u }));
  expect(onSelect).toHaveBeenCalledWith("ready");
});

test("shows the chosen device and its state in the hint row", () => {
  renderChoices([ready], {}, "ready");
  expect(field()).toHaveTextContent("iPhone 17");
  const hint = screen.getByRole("group", { name: "iPhone 17" });
  expect(within(hint).getByText("Running · iOS 27.1")).toBeVisible();
  expect(within(hint).queryByRole("button")).toBeNull();
});

test("while nothing runs, a stopped device shows with Start", async () => {
  const user = userEvent.setup();
  const { onStart } = renderChoices([stopped("iPhone 16")]);
  expect(field()).toHaveTextContent("iPhone 16");
  const hint = screen.getByRole("group", { name: "iPhone 16" });
  expect(within(hint).getByText("Stopped · iOS 26.5")).toBeVisible();
  await user.click(
    within(hint).getByRole("button", { name: "Start iPhone 16" })
  );
  expect(onStart).toHaveBeenCalledWith("iPhone 16");
});

test("a starting device shows progress and cannot be started twice", () => {
  renderChoices([stopped("iPhone 16")], {
    "iPhone 16": { _tag: "starting" },
  });
  const hint = screen.getByRole("group", { name: "iPhone 16" });
  expect(hint).toHaveAttribute("aria-busy", "true");
  expect(within(hint).getByText("Starting… iOS 26.5")).toBeVisible();
  expect(
    within(hint).getByRole("button", { name: "Start iPhone 16" })
  ).toBeDisabled();
});

test("a failed start shows its reason and can be tried again", async () => {
  const user = userEvent.setup();
  const { onStart } = renderChoices(
    [ready, stopped("iPhone 16")],
    { "iPhone 16": { _tag: "failed", reason: "Missing system image" } },
    "iPhone 16"
  );
  const hint = screen.getByRole("group", { name: "iPhone 16" });
  expect(within(hint).getByText("Missing system image")).toBeInTheDocument();
  await user.click(
    within(hint).getByRole("button", { name: "Try starting iPhone 16" })
  );
  expect(onStart).toHaveBeenCalledWith("iPhone 16");
  // The ready device stays a choice beside the failure.
  await user.click(field());
  expect(
    await screen.findByRole("option", { name: /iPhone 17/u })
  ).not.toHaveAttribute("aria-disabled", "true");
});

test("an unavailable device is a disabled option that says why", async () => {
  const user = userEvent.setup();
  renderChoices([
    ready,
    {
      detail: "iOS 27.1",
      id: "busy",
      kind: "Simulator",
      name: "iPhone Air",
      status: { _tag: "unavailable", reason: "Shutting Down" },
    },
  ]);
  expect(screen.getByText("Choose one of the running devices.")).toBeVisible();
  await user.click(field());
  expect(
    await screen.findByRole("option", { name: /iPhone Air.*Shutting Down/u })
  ).toHaveAttribute("aria-disabled", "true");
});

test("says so when there is no device, and refreshes on request", async () => {
  const user = userEvent.setup();
  const { onRefresh } = renderChoices([]);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("Nothing exists.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh devices" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test("maps simctl states to card states", () => {
  const device = {
    name: "iPhone 17",
    runtimeVersion: "27.1",
    udid: "11111111-1111-1111-1111-111111111111",
  };
  expect(iosDeviceChoice({ ...device, state: "Booted" }).status._tag).toBe(
    "ready"
  );
  expect(iosDeviceChoice({ ...device, state: "Shutdown" })).toMatchObject({
    bootId: device.udid,
    status: { _tag: "stopped" },
  });
  expect(iosDeviceChoice({ ...device, state: "Shutting Down" }).status).toEqual(
    { _tag: "unavailable", reason: "Shutting Down" }
  );
});
