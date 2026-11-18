import { AgentSessionId } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidDevice } from "@/components/agent/android-device";
import { AndroidInstructionEntry } from "@/components/agent/android-dock";
import {
  selectable,
  unavailableReason,
} from "@/components/agent/android-setup-state";
import { AndroidEmptyState } from "@/components/agent/android-workspace";
import { pauseCodeOf } from "@/components/agent/android-workspace-state";

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
      agentDriving={false}
      device="Pixel_9"
      lockedReason={undefined}
      observation={null}
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
  // The rail beside the frame holds every control; nothing sits on the glass.
  const rail = screen.getByRole("navigation", { name: "Device controls" });
  expect(
    within(rail)
      .getAllByRole("button")
      .map((button) => button.ariaLabel)
  ).toEqual([
    "Android Back",
    "Android Home",
    "Android Recents",
    "Rotate to landscape",
    "Device settings",
    "Screen elements",
    "Stream diagnostics",
  ]);
  expect(
    screen.getAllByRole("button").filter((button) => !rail.contains(button))
  ).toEqual([]);
});

test("the rail rotates the device and changes its appearance and location", async () => {
  const user = userEvent.setup();
  const onEmulate = vi.fn();
  render(
    <AndroidDevice
      agentDriving={false}
      device="Pixel_9"
      lockedReason={undefined}
      observation={null}
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

test("a secure pause names the hidden window instead of a disconnected device", () => {
  render(
    <AndroidDevice
      agentDriving={false}
      device="Pixel_9"
      lockedReason={undefined}
      observation={null}
      canAct={false}
      live
      onDeviceKey={vi.fn()}
      onEmulate={vi.fn()}
      onInput={vi.fn()}
      paused
      pending={false}
      refusal={null}
      pauseCode={pauseCodeOf(["secure_window", "forwarded_input_unverified"])}
      sessionId={AgentSessionId.make("agent-android")}
      unavailable=""
    />
  );
  // The tap that opened the window went unobserved, so its gap follows the
  // pause cause; the stage still names the secure window.
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
      agentDriving={false}
      device="Pixel_9"
      lockedReason={undefined}
      observation={null}
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
