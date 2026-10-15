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
  expect(selectable(phone)).toMatchObject({ kind: "physical", model: "A059" });
  expect(unavailableReason({ ...phone, state: "unauthorized" })).toBe(
    "Allow USB debugging on the device"
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
      secure={false}
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
      onBack={vi.fn()}
      onPick={vi.fn()}
      paused
      pending={false}
      refusal={null}
      secure
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
