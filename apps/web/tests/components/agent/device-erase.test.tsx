import { OperationId } from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { DeviceChoice } from "@/components/agent/device-choice-state";
import { DeviceChoices } from "@/components/agent/device-choices";
import type { DeviceEraseControls } from "@/components/agent/device-erase-state";

afterEach(cleanup);

const stopped: DeviceChoice = {
  bootId: "Pixel_8",
  detail: "Android emulator",
  eraseId: "Pixel_8",
  id: "Pixel_8",
  kind: "Emulator",
  name: "Pixel_8",
  status: { _tag: "stopped" },
};
const running = (name: string): DeviceChoice => ({
  detail: "emulator-5554 · API 36",
  eraseId: name,
  id: `serial-${name}`,
  kind: "Emulator",
  name,
  status: { _tag: "ready" },
});

const controls = (
  overrides: Partial<DeviceEraseControls> = {}
): DeviceEraseControls => ({
  confirm: vi.fn(),
  dismiss: vi.fn(),
  erasing: {},
  owned: [],
  platform: "android",
  requests: [],
  ...overrides,
});

const choices = (erase: DeviceEraseControls, devices: DeviceChoice[]) =>
  render(
    <DeviceChoices
      devices={devices}
      emptyMessage="No emulator."
      erase={erase}
      onSelect={vi.fn()}
      onStart={vi.fn()}
      selected={null}
      starts={{}}
    />
  );

test("offers Erase on a stopped device and on one this process started", () => {
  const erase = controls({ owned: ["Pixel_9"] });
  choices(erase, [stopped, running("Pixel_9")]);
  fireEvent.click(screen.getByRole("button", { name: "Erase Pixel_8" }));
  expect(erase.confirm).toHaveBeenCalledWith("Pixel_8", "Pixel_8");
  fireEvent.click(screen.getByRole("button", { name: "Erase Pixel_9" }));
  expect(erase.confirm).toHaveBeenCalledWith("Pixel_9", "Pixel_9");
});

test("asks the user to stop a running device it did not start", () => {
  choices(controls(), [running("Pixel_7")]);
  expect(screen.queryByRole("button", { name: "Erase Pixel_7" })).toBeNull();
  expect(screen.getByText("Stop this device to erase it.")).toBeTruthy();
});

test("shows an agent's erase request, which only the user can answer", () => {
  const erase = controls({
    requests: [
      {
        device: "Pixel_8",
        id: OperationId.make("erase-1"),
        platform: "android",
        requestedAt: "2026-11-14T00:00:00.000Z",
        status: "pending",
      },
    ],
  });
  choices(erase, [stopped]);
  const request = screen.getByRole("region", { name: "Device Erase request" });
  expect(request.textContent).toContain("The agent asks to erase Pixel_8.");
  fireEvent.click(
    within(request).getByRole("button", { name: "Erase device" })
  );
  expect(erase.confirm).toHaveBeenCalledWith("Pixel_8", "Pixel_8", "erase-1");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(erase.dismiss).toHaveBeenCalledWith("erase-1");
});
