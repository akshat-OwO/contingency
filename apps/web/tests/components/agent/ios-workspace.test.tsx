import { AgentSessionId } from "@contingency/protocol";
import type { IosWorkspaceSnapshot } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { DeviceRail } from "@/components/agent/android-device";
import { iosRailEnabled } from "@/components/agent/ios-dock-state";
import { IosFieldEntry, IosRecovery } from "@/components/agent/ios-workspace";

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
      emulation={undefined}
      onEmulate={vi.fn()}
      onKey={vi.fn()}
      platform="iOS"
    />
  );
  for (const button of screen.getAllByRole("button")) {
    expect(button).toHaveProperty("disabled", true);
  }
});

const noVariables: IosWorkspaceSnapshot["variables"] = [];

test("an ordinary field takes a named Variable as well as public text", async () => {
  const user = userEvent.setup();
  const send = vi.fn(() => true);
  const field = {
    name: "Login name",
    observationId: "observation-1",
    role: "text-field",
    target: "login-name",
  };
  const session = {
    id: AgentSessionId.make("agent-ios-1"),
    variables: noVariables,
  };
  const { rerender } = render(
    <IosFieldEntry
      field={field}
      onDismiss={vi.fn()}
      pending={false}
      send={send}
      session={session}
    />
  );
  expect(
    screen.getByRole("form", { name: "Type into Login name" })
  ).toBeVisible();
  const variables = screen.getByRole("form", { name: "Field Variable" });
  await user.type(
    within(variables).getByRole("textbox", { name: "Variable name" }),
    "USERNAME"
  );
  await user.click(
    within(variables).getByRole("button", { name: "Request Variable" })
  );
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ _tag: "variable-request", name: "USERNAME" })
  );
  // Once supplied, the Variable is entered into the selected field.
  rerender(
    <IosFieldEntry
      field={field}
      onDismiss={vi.fn()}
      pending={false}
      send={send}
      session={{
        ...session,
        variables: [
          {
            name: "USERNAME",
            purpose: "Input for Login name",
            requestId: "request-1",
            setup: false,
            status: "supplied",
          },
        ],
      }}
    />
  );
  await user.click(screen.getByRole("button", { name: "Enter USERNAME" }));
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      _tag: "input",
      action: { _tag: "variable", name: "USERNAME", target: "login-name" },
      observationId: "observation-1",
    })
  );
});
