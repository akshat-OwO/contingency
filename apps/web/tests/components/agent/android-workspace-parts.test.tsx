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
import {
  AndroidEmptyState,
  AndroidPreparingState,
} from "@/components/agent/android-workspace";

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

test("the device offers only Back and draws nothing over the stream", () => {
  render(
    <AndroidDevice
      canAct
      live={false}
      onBack={vi.fn()}
      onInput={vi.fn()}
      paused={false}
      pending={false}
      secure={false}
      sessionId={AgentSessionId.make("agent-android")}
      unavailable="Prepare the device."
    />
  );
  // A refused click is said in the dock, never on or beside the glass.
  expect(screen.queryByRole("status")).toBeNull();
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
      onInput={vi.fn()}
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

test("shows a distinct preparing stage while a confirmed start prepares the app", () => {
  render(
    <AndroidPreparingState
      selection={{
        device: {
          api: 36,
          avd: "Pixel_9",
          fingerprint: "google/sdk_gphone64_arm64",
          host: "local",
          serial: "emulator-5554",
        },
        environment: {
          androidVersion: "16",
          appBuild: "1",
          appId: "dev.fixture",
          startingState: "Fresh fixture data",
        },
        helperConsent: "none",
        outcomes: [{ name: "Done", role: "text" }],
        setup: {
          conditions: [{ name: "Fresh fixture data", role: "text" }],
          kind: "restart-app",
        },
      }}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Preparing your app" })
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Installing and launching it on the device"
  );
  expect(screen.getByText("dev.fixture")).toBeVisible();
  expect(screen.getByText("Pixel_9 · API 36")).toBeVisible();
  expect(
    document.querySelector('[data-slot="watcher-loader"]')
  ).toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  // Nothing to press while it prepares: the start is already on its way.
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("keeps the empty state and its disabled Open while a pick opens a session", () => {
  render(
    <AndroidEmptyState
      pending
      onOpen={vi.fn()}
      onSelect={vi.fn()}
      sessions={[]}
    />
  );
  expect(
    screen.getByRole("heading", { name: "Opening Android session" })
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Opening the session");
  expect(
    screen.getByRole("button", { name: "Open Android session" })
  ).toBeDisabled();
});
