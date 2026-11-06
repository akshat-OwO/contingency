import { AgentSessionId } from "@contingency/protocol";
import type { IosWorkspaceSnapshot } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

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

test("returns to the Target App only for a foreground refusal", async () => {
  const onRecover = vi.fn();
  render(
    <IosRecovery
      pending={false}
      refusal={{
        code: "foreign_app_foreground",
        recovery: "return-to-target-app",
      }}
      onRecover={onRecover}
    />
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Return to Target App" }));
  expect(onRecover).toHaveBeenCalledExactlyOnceWith("return-to-target-app");
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
