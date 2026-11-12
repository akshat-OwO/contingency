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
  starts: Readonly<Record<string, DeviceStart>> = {}
) => {
  const onSelect = vi.fn();
  const onStart = vi.fn();
  render(
    <DeviceChoices
      devices={devices}
      emptyMessage="Nothing exists."
      onSelect={onSelect}
      onStart={onStart}
      selected={null}
      starts={starts}
    />
  );
  return { onSelect, onStart };
};

test("a ready device is selectable", async () => {
  const { onSelect } = renderChoices([ready]);
  await userEvent.click(screen.getByRole("button", { name: /iPhone 17/u }));
  expect(onSelect).toHaveBeenCalledWith("ready");
});

test("a stopped device offers Start and opens its group while nothing is ready", async () => {
  const { onStart } = renderChoices([stopped("iPhone 16")]);
  expect(
    screen.getByText("No device is running. Start one below.")
  ).toBeVisible();
  const card = screen.getByRole("group", { name: "iPhone 16" });
  expect(within(card).getByText("Stopped · iOS 26.5")).toBeVisible();
  await userEvent.click(
    within(card).getByRole("button", { name: "Start iPhone 16" })
  );
  expect(onStart).toHaveBeenCalledWith("iPhone 16");
});

test("a starting device shows progress and cannot be started twice", () => {
  renderChoices([stopped("iPhone 16")], {
    "iPhone 16": { _tag: "starting" },
  });
  const card = screen.getByRole("group", { name: "iPhone 16" });
  expect(card).toHaveAttribute("aria-busy", "true");
  expect(within(card).getByText("Starting… iOS 26.5")).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Start iPhone 16" })
  ).toBeDisabled();
});

test("a failed start shows its reason and can be tried again", async () => {
  const { onStart } = renderChoices([ready, stopped("iPhone 16")], {
    "iPhone 16": { _tag: "failed", reason: "Missing system image" },
  });
  const card = screen.getByRole("group", { name: "iPhone 16" });
  expect(within(card).getByText("Missing system image")).toBeInTheDocument();
  await userEvent.click(
    within(card).getByRole("button", { name: "Try starting iPhone 16" })
  );
  expect(onStart).toHaveBeenCalledWith("iPhone 16");
  // The ready device stays selectable beside the failure.
  expect(screen.getByRole("button", { name: /iPhone 17/u })).toBeEnabled();
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
