import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { DeviceRail } from "@/components/agent/android-device";
import { iosRailEnabled } from "@/components/agent/ios-dock-state";
import { IosRecovery } from "@/components/agent/ios-workspace";

afterEach(cleanup);

test("offers transport recovery for a structured capture refusal", async () => {
  const onRecover = vi.fn();
  render(
    <IosRecovery
      pending={false}
      refusal={{ code: "capture_incomplete", recovery: "recover" }}
      onRecover={onRecover}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Recover selected simulator" }));
  expect(onRecover).toHaveBeenCalledExactlyOnceWith("recover");
});

test("goes Home when no app can be named in front", async () => {
  const onRecover = vi.fn();
  render(
    <IosRecovery
      pending={false}
      refusal={{ code: "foreground_app_unknown", recovery: "go-home" }}
      onRecover={onRecover}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Go Home" }));
  expect(onRecover).toHaveBeenCalledExactlyOnceWith("recover");
});

test("the iOS rail offers Home and the App Switcher, never Back", async () => {
  const user = userEvent.setup();
  const onKey = vi.fn();
  const onEmulate = vi.fn();
  render(
    <DeviceRail
      canAct
      card={null}
      elements={3}
      onCard={vi.fn()}
      streamLive
      emulation={{
        appearance: "light",
        location: null,
        orientation: "portrait",
      }}
      onEmulate={onEmulate}
      onKey={onKey}
      platform="iOS"
    />
  );
  expect(
    screen.getAllByRole("button").map((button) => button.ariaLabel)
  ).toEqual([
    "iOS Home",
    "iOS App Switcher",
    "Rotate to landscape",
    "Device settings",
    "Screen elements",
    "Stream diagnostics",
  ]);
  await user.click(screen.getByRole("button", { name: "iOS Home" }));
  await user.click(screen.getByRole("button", { name: "iOS App Switcher" }));
  expect(onKey.mock.calls).toEqual([["GoHome"], ["AppSwitch"]]);
  await user.click(screen.getByRole("button", { name: "Rotate to landscape" }));
  expect(onEmulate).toHaveBeenLastCalledWith({
    _tag: "orientation",
    orientation: "landscape",
  });
});

test("the iOS rail is enabled only while the user holds a running session", () => {
  expect(iosRailEnabled({ controller: "user", phase: "running" })).toBe(true);
  for (const session of [
    { controller: "agent", phase: "running" },
    { controller: "user", phase: "paused" },
    { controller: "user", phase: "pending" },
    { controller: "user", phase: "closed" },
  ] as const) {
    expect(iosRailEnabled(session)).toBe(false);
  }
  render(
    <DeviceRail
      canAct={false}
      card={null}
      elements={3}
      lockedReason="The agent is driving. Take control to use the simulator."
      onCard={vi.fn()}
      streamLive={false}
      emulation={undefined}
      onEmulate={vi.fn()}
      onKey={vi.fn()}
      platform="iOS"
    />
  );
  // Stream diagnostics reads the stream, so it stays open to everyone.
  const stream = screen.getByRole("button", { name: "Stream diagnostics" });
  expect(stream).toBeEnabled();
  for (const button of screen.getAllByRole("button")) {
    if (button !== stream) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "aria-description",
        "The agent is driving. Take control to use the simulator."
      );
    }
  }
});
