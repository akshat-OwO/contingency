import { AgentSessionId } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { AndroidDevice } from "@/components/agent/android-device";
import { AndroidFieldEntry } from "@/components/agent/android-dock";
import {
  selectable,
  unavailableReason,
} from "@/components/agent/android-setup-state";
import { framePoint } from "@/components/agent/android-stream-point";

afterEach(cleanup);

test("reports a click as fractions of the displayed frame", () => {
  const box = { height: 800, left: 100, top: 50, width: 360 };
  expect(framePoint({ clientX: 280, clientY: 450 }, box)).toEqual({
    x: 0.5,
    y: 0.5,
  });
  // A click on the rounded rim lands on the nearest edge, never outside.
  expect(framePoint({ clientX: 90, clientY: 900 }, box)).toEqual({
    x: 0,
    y: 1,
  });
  expect(framePoint({ clientX: 0, clientY: 0 }, { ...box, width: 0 })).toBe(
    null
  );
});

test("offers only identified API 36 devices", () => {
  const emulator = {
    api: 36,
    avd: "Pixel_9",
    fingerprint: "google/sdk_gphone",
    kind: "emulator",
    model: "sdk_gphone64_arm64",
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
  expect(selectable(phone)).toMatchObject({ kind: "physical", model: "A059" });
  expect(unavailableReason({ ...phone, state: "unauthorized" })).toBe(
    "Allow USB debugging on the device"
  );
  expect(unavailableReason({ ...emulator, api: 35 })).toBe(
    "API 35; needs API 36"
  );
  expect(selectable({ ...emulator, fingerprint: null })).toBeNull();
});

test("the device shows a refusal beside the stream and draws nothing over it", () => {
  render(
    <AndroidDevice
      canAct
      live={false}
      onBack={vi.fn()}
      onPick={vi.fn()}
      paused={false}
      pending={false}
      refusal="Nothing to activate there. No input was sent."
      sessionId={AgentSessionId.make("agent-android")}
      unavailable="Prepare the device."
    />
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Nothing to activate there. No input was sent."
  );
  // Back is the only control; there are no per-element targets.
  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel)
  ).toEqual(["Android Back"]);
});

test("types public text into the picked field from the dock", async () => {
  const onSubmit = vi.fn();
  render(
    <AndroidFieldEntry
      disabled={false}
      field={{
        name: "Shopper name",
        observationId: "observation-2",
        role: "text-field",
        target: "@e3",
      }}
      onDismiss={vi.fn()}
      onSubmit={onSubmit}
    />
  );
  expect(screen.getByRole("form", { name: "Type into Shopper name" }));
  expect(screen.getByRole("button", { name: "Variable" })).toBeDisabled();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Text for Shopper name" }),
    "Fixture Shopper{Enter}"
  );
  expect(onSubmit).toHaveBeenCalledWith("Fixture Shopper");
});
