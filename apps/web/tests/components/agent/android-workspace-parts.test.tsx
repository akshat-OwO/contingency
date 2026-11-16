import { AgentSessionId } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidDevice } from "@/components/agent/android-device";
import {
  AndroidFieldEntry,
  AndroidInstructionEntry,
} from "@/components/agent/android-dock";
import {
  selectable,
  unavailableReason,
} from "@/components/agent/android-setup-state";
import { AndroidEmptyState } from "@/components/agent/android-workspace";

afterEach(cleanup);

test("offers only identified devices in the API 30 to 36 Support Matrix", () => {
  const emulator = {
    api: 36,
    avd: "Pixel_9",
    fingerprint: "google/sdk_gphone",
    kind: "emulator",
    model: "sdk_gphone64_arm64",
    release: "16",
    serial: "emulator-5554",
    state: "device",
  } as const;
  expect(selectable(emulator)).toEqual({
    api: 36,
    avd: "Pixel_9",
    fingerprint: "google/sdk_gphone",
    host: "local",
    serial: "emulator-5554",
  });
  const phone = {
    ...emulator,
    avd: null,
    kind: "physical",
    model: "A059",
    serial: "phone",
  } as const;
  expect(selectable(phone)).toBeNull();
  expect(unavailableReason({ ...phone, state: "unauthorized" })).toBe(
    "physical_device_unsupported: Select an Android emulator"
  );
  expect(selectable({ ...emulator, api: 30, release: "11" })).toMatchObject({
    api: 30,
  });
  expect(unavailableReason({ ...emulator, api: 33 })).toBeNull();
  expect(unavailableReason({ ...emulator, api: 29 })).toBe(
    "API 29; needs API 30–36"
  );
  expect(unavailableReason({ ...emulator, api: 37 })).toBe(
    "API 37; needs API 30–36"
  );
  expect(selectable({ ...emulator, fingerprint: null })).toBeNull();
  expect(unavailableReason({ ...emulator, release: null })).toBe(
    "Identity unreadable"
  );
});

test("the device rail offers the device's keys and settings and draws nothing over the stream", () => {
  render(
    <AndroidDevice
      canAct
      live={false}
      onDeviceKey={vi.fn()}
      onEmulate={vi.fn()}
      onInput={vi.fn()}
      paused={false}
      pending={false}
      sessionId={AgentSessionId.make("agent-android")}
      unavailable="Prepare the device."
    />
  );
  // A refused click is said in the dock, never on or beside the glass.
  expect(screen.queryByRole("status")).toBeNull();
  // The device's own keys are the only controls; there are no per-element targets.
  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel)
  ).toEqual([
    "Android Back",
    "Android Home",
    "Android Recents",
    "Rotate to landscape",
    "Device settings",
  ]);
});

test("the rail rotates the device and changes its appearance and location", async () => {
  const user = userEvent.setup();
  const onEmulate = vi.fn();
  render(
    <AndroidDevice
      canAct
      emulation={{
        appearance: "light",
        location: null,
        orientation: "landscape",
      }}
      live={false}
      onDeviceKey={vi.fn()}
      onEmulate={onEmulate}
      onInput={vi.fn()}
      paused={false}
      pending={false}
      sessionId={AgentSessionId.make("agent-android")}
      unavailable="Prepare the device."
    />
  );
  // The toggle names where it goes from the device's current orientation.
  await user.click(screen.getByRole("button", { name: "Rotate to portrait" }));
  expect(onEmulate).toHaveBeenLastCalledWith({
    _tag: "orientation",
    orientation: "portrait",
  });
  await user.click(screen.getByRole("button", { name: "Device settings" }));
  await user.click(await screen.findByRole("radio", { name: "Dark" }));
  expect(onEmulate).toHaveBeenLastCalledWith({
    _tag: "appearance",
    appearance: "dark",
  });
  await user.type(screen.getByRole("textbox", { name: "Latitude" }), "12.97");
  await user.type(screen.getByRole("textbox", { name: "Longitude" }), "77.59");
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(onEmulate).toHaveBeenLastCalledWith({
    _tag: "location",
    latitude: 12.97,
    longitude: 77.59,
  });
});

test("types public text into the picked field from the dock", async () => {
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AndroidFieldEntry
      disabled={false}
      field={{
        name: "Shopper name",
        observationId: "observation-2",
        role: "text-field",
        target: "@e3",
      }}
      onDismiss={onDismiss}
      onRequest={vi.fn()}
      onVariable={vi.fn()}
      variables={[]}
      onSubmit={onSubmit}
    />
  );
  expect(screen.getByRole("form", { name: "Type into Shopper name" }));
  expect(screen.queryByRole("combobox", { name: "Variable" })).toBeNull();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Text for Shopper name" }),
    "Fixture Shopper{Enter}"
  );
  expect(onSubmit).toHaveBeenCalledWith("Fixture Shopper");
  await userEvent.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledOnce();
});

test("a password field enters a supplied Variable by reference and has no public text entry", async () => {
  const onVariable = vi.fn();
  const onSubmit = vi.fn();
  const onRequest = vi.fn();
  render(
    <AndroidFieldEntry
      disabled={false}
      field={{
        name: "Private field",
        observationId: "observed",
        password: true,
        role: "text-field",
        target: "@password",
      }}
      onDismiss={vi.fn()}
      onRequest={onRequest}
      onSubmit={onSubmit}
      onVariable={onVariable}
      variables={[
        {
          name: "PASSWORD",
          purpose: "Sign in",
          requestId: "request",
          setup: false,
          status: "supplied",
        },
      ]}
    />
  );
  expect(
    screen.queryByRole("textbox", { name: "Text for Private field" })
  ).toBeNull();
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "Variable" }),
    "PASSWORD"
  );
  await userEvent.click(screen.getByRole("button", { name: "Enter Variable" }));
  expect(onVariable).toHaveBeenCalledWith("PASSWORD");
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Request Variable" })
  );
  expect(onRequest).toHaveBeenCalledWith("PASSWORD");
});

test("a secure pause names the hidden window instead of a disconnected device", () => {
  render(
    <AndroidDevice
      canAct={false}
      live
      onDeviceKey={vi.fn()}
      onEmulate={vi.fn()}
      onInput={vi.fn()}
      paused
      pending={false}
      refusal={null}
      pauseCode="secure_window"
      sessionId={AgentSessionId.make("agent-android")}
      unavailable=""
    />
  );
  expect(screen.getByText("Secure window, not visible")).toBeVisible();
  expect(screen.getByText(/outcome is inconclusive/u)).toBeVisible();
  expect(screen.queryByText("Device disconnected")).toBeNull();
  expect(
    screen.queryByRole("img", { name: "Selected device live display" })
  ).toBeNull();
});

test("a submitted comment keeps its draft until the composer closes", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(
    <AndroidInstructionEntry
      onDismiss={vi.fn()}
      onSubmit={onSubmit}
      pending={false}
    />
  );
  const box = screen.getByRole("textbox", { name: "Instruction" });
  await user.type(box, "The total must include tax{Enter}");
  expect(onSubmit).toHaveBeenCalledWith("The total must include tax");
  // A refused save leaves the words for another try.
  expect(box).toHaveValue("The total must include tax");
});

test("keeps the empty state and its disabled start while a pick opens a session", () => {
  render(
    <AndroidEmptyState
      pending
      onStartNew={vi.fn()}
      onSelect={vi.fn()}
      sessions={[]}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Opening Android session" })
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Opening the session");
  expect(
    screen.getByRole("button", { name: "Start an Android session" })
  ).toBeDisabled();
});

const pausedDevice = (pauseCode: string) =>
  render(
    <AndroidDevice
      canAct={false}
      live
      onDeviceKey={vi.fn()}
      onEmulate={vi.fn()}
      onInput={vi.fn()}
      paused
      pauseCode={pauseCode}
      pending={false}
      sessionId={AgentSessionId.make("agent-android")}
      unavailable=""
    />
  );

test("an incomplete capture pause says the device is still connected", () => {
  pausedDevice("capture_incomplete");
  expect(screen.getByText("Screen capture incomplete")).toBeVisible();
  expect(screen.getByText(/device is still connected/u)).toBeVisible();
  expect(screen.queryByText("Device disconnected")).toBeNull();
});

test("only a lost device says the device disconnected", () => {
  pausedDevice("device_disconnected");
  expect(screen.getByText("Device disconnected")).toBeVisible();
  cleanup();
  pausedDevice("runtime_failed");
  expect(screen.getByText("Execution paused")).toBeVisible();
  expect(screen.queryByText("Device disconnected")).toBeNull();
});
