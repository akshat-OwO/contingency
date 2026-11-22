import { AgentSessionId, FlowName } from "@contingency/protocol";
import type {
  AndroidWorkspaceSnapshot,
  NativeForward,
} from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { parseAndroidPermissionDecisions } from "@/components/agent/android-setup-state";
import {
  AndroidSessionView,
  AndroidEmptyState,
} from "@/components/agent/android-workspace";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import type { RpcDependencies } from "@/lib/rpc-dependencies";

type WorkspaceState = Parameters<typeof AndroidSessionView>[0]["state"];

const app = {
  label: "Permission fixture",
  launchActivity: "dev.fixture/.MainActivity",
  package: "dev.fixture",
  versionCode: "1",
  versionName: "1.0",
};
const completed: AndroidWorkspaceSnapshot = {
  assessment: null,
  captureGaps: [],
  captureState: null,
  cleanup: null,
  completedAt: "2026-10-15T00:00:00.000Z",
  controller: "user",
  error: null,
  field: null,
  flowName: FlowName.make("finished-checkout"),
  id: AgentSessionId.make("agent-completed"),
  kind: "run",
  observation: null,
  phase: "completed",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: { capabilities: [], platform: "android" },
  revision: 0,
  selection: {
    device: {
      api: 36,
      avd: "Pixel_9",
      fingerprint: "Nothing/A059",
      host: "local",
      serial: "phone",
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
      activity: app.launchActivity,
      conditions: [{ name: "Fresh fixture data", role: "text" }],
      kind: "restart-activity",
    },
  },
  startedAt: "2026-10-15T00:00:00.000Z",
  takeoverOccurred: false,
};
const paused = {
  ...completed,
  flowName: FlowName.make("paused-checkout"),
  id: AgentSessionId.make("agent-paused"),
  phase: "paused",
} as const;
afterEach(cleanup);

test("offers the listed sessions without a selected Android session", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <AndroidEmptyState
      onStartNew={vi.fn()}
      onSelect={onSelect}
      sessions={[paused, completed]}
    />
  );
  // The way home leads, as the platform switcher it replaced did.
  await user.tab();
  expect(screen.getByRole("link", { name: "Contingency home" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("combobox", { name: "Agent Session" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  const dialog = await screen.findByRole("dialog", { name: "Agent Sessions" });
  expect(
    within(dialog).getByRole("option", {
      name: "paused-checkout · Android Run",
    })
  ).toBeVisible();
  await user.click(
    within(dialog).getByRole("option", {
      name: "finished-checkout · Android Run",
    })
  );
  expect(onSelect).toHaveBeenCalledWith(completed.id);
});

test("says a linked session is gone without offering a session selector", () => {
  render(
    <AndroidEmptyState
      onStartNew={vi.fn()}
      onSelect={vi.fn()}
      sessions={[]}
      unavailable
    />
  );
  expect(
    screen.getByText("The session this link named is no longer available.")
  ).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Agent Session" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Start an Android session" })
  ).toBeEnabled();
});

test("preserves explicit permission grants and denials and rejects ambiguous declarations", () => {
  expect(
    parseAndroidPermissionDecisions(
      "grant android.permission.POST_NOTIFICATIONS\nrevoke android.permission.CAMERA"
    )
  ).toEqual([
    { decision: "grant", permission: "android.permission.POST_NOTIFICATIONS" },
    { decision: "revoke", permission: "android.permission.CAMERA" },
  ]);
  expect(
    parseAndroidPermissionDecisions(
      "revoke android.permission.POST_NOTIFICATIONS"
    )
  ).toEqual([
    { decision: "revoke", permission: "android.permission.POST_NOTIFICATIONS" },
  ]);
  expect(
    parseAndroidPermissionDecisions(
      "grant android.permission.CAMERA\nrevoke android.permission.CAMERA"
    )
  ).toBeUndefined();
  expect(parseAndroidPermissionDecisions("grant camera")).toBeUndefined();
});

test("Confirmation keeps the device healthy and Take control enables the rail", async () => {
  const user = userEvent.setup();
  const session: AndroidWorkspaceSnapshot = {
    ...completed,
    boundary: {
      action: { action: '{"_tag":"activate","target":"@e2"}', type: "android" },
      description: 'Activate button "Place order" in dev.fixture',
      id: "boundary",
      operationId: "attempt",
      reason: "confirmation",
      requested: "Checkout",
    },
    completedAt: null,
    controller: "agent",
    observation: {
      capturedAt: "",
      height: 800,
      id: "observed",
      image: null,
      nodes: [],
      width: 360,
    },
    phase: "running",
  };
  const mutate = vi.fn();
  const forwarded: NativeForward[] = [];
  const overrides: Partial<RpcDependencies> = {
    androidWorkspaceForwardMutation: Atom.fn(
      (request: { readonly payload: NativeForward }) =>
        Effect.sync(() => {
          forwarded.push(request.payload);
        })
    ),
  };
  const props = {
    mutate,
    notices: null,
    pending: false,
    session,
    setState: vi.fn(),
    state: {
      attached: null,
      dismissedField: null,
      failure: null,
      highlightedComment: null,
      inputRefusal: null,
      instructing: false,
      instructionPending: false,
      picking: false,
      refusalDismissed: false,
      session,
    },
  };
  const view = render(<AndroidSessionView {...props} />, {
    wrapper: ({ children }) => (
      <RpcDependenciesProvider overrides={overrides}>
        {children}
      </RpcDependenciesProvider>
    ),
  });
  expect(screen.queryByText("Device disconnected")).toBeNull();
  // The island offers Task details beside the action; closing the session
  // is in the session picker instead (#753).
  const status = screen.getByRole("region", { name: "Session status" });
  expect(
    within(status).getByRole("button", { name: "Task details" })
  ).toBeVisible();
  expect(
    within(status).queryByRole("button", { name: "Close session" })
  ).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Agent Session" }));
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Agent Sessions" })
    ).getByRole("button", { name: "Close session" })
  );
  expect(mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({ _tag: "close", sessionId: session.id })
  );
  for (const name of ["Android Back", "Android Home", "Android Recents"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  await user.click(screen.getByRole("button", { name: "Take control" }));
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({ _tag: "control", controller: "user" })
  );
  view.rerender(
    <AndroidSessionView
      {...props}
      session={{ ...session, controller: "user" }}
    />
  );
  await user.click(screen.getByRole("button", { name: "Android Back" }));
  await user.click(screen.getByRole("button", { name: "Android Home" }));
  await user.click(screen.getByRole("button", { name: "Android Recents" }));
  // The rail's keys are Forwarded Input: each goes straight to the device.
  await waitFor(() =>
    expect(forwarded.flatMap((request) => request.inputs)).toEqual(
      ["GoBack", "GoHome", "AppSwitch"].flatMap((key) => [
        expect.objectContaining({ _tag: "key", action: "down", key }),
        expect.objectContaining({ _tag: "key", action: "up", key }),
      ])
    )
  );
});

test("refused input is said above the dock, outside its measured height, and set aside while commenting", async () => {
  const user = userEvent.setup();
  const session: AndroidWorkspaceSnapshot = {
    ...completed,
    captureState: { _tag: "recording", startedAt: "2026-10-15T00:00:00.000Z" },
    completedAt: null,
    id: AgentSessionId.make("agent-refused-pick"),
    kind: "teaching",
    observation: {
      capturedAt: "",
      height: 800,
      id: "observed",
      image: null,
      nodes: [
        {
          bounds: { height: 40, width: 200, x: 80, y: 100 },
          covered: false,
          editable: false,
          name: "Banner",
          password: false,
          role: "text",
          target: "@e1",
        },
      ],
      width: 360,
    },
    phase: "running",
  };
  const state: WorkspaceState = {
    attached: null,
    dismissedField: null,
    failure: null,
    inputRefusal: null,
    instructing: false,
    instructionPending: false,
    picking: false,
    refusalDismissed: false,
    session,
  };
  const props = {
    mutate: vi.fn(),
    notices: null,
    pending: false,
    session,
    setState:
      vi.fn<(update: (current: WorkspaceState) => WorkspaceState) => void>(),
    state,
  };
  const overrides: Partial<RpcDependencies> = {
    androidWorkspaceForwardMutation: Atom.fn(() =>
      Effect.fail(
        new Error(
          "Only the user controlling a running session can send input. Nothing was sent."
        )
      )
    ),
  };
  const view = render(<AndroidSessionView {...props} />, {
    wrapper: ({ children }) => (
      <RpcDependenciesProvider overrides={overrides}>
        {children}
      </RpcDependenciesProvider>
    ),
  });
  await user.click(screen.getByRole("button", { name: "Screen elements" }));
  await user.click(
    await screen.findByRole("button", { name: "Activate Banner" })
  );
  await waitFor(() => expect(props.setState).toHaveBeenCalled());
  let refused = state;
  for (const [update] of props.setState.mock.calls) {
    refused = update(refused);
  }
  view.rerender(<AndroidSessionView {...props} state={refused} />);
  const dock = screen.getByRole("region", { name: "Session status" });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Only the user controlling a running session can send input. Nothing was sent."
  );
  // The refusal floats above the dock rather than growing it, so the device
  // stage's reserved space (`--dock-height`) never changes with it.
  const alert = screen.getByRole("alert");
  expect(dock).not.toContainElement(alert);
  expect(alert.closest('[data-slot="dock-notices"]')).not.toBeNull();
  expect(alert).not.toHaveFocus();
  view.rerender(
    <AndroidSessionView
      {...props}
      state={{ ...refused, instructing: true, refusalDismissed: true }}
    />
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a native Teaching comment attaches the element the user picks on the screen", async () => {
  const user = userEvent.setup();
  const session: AndroidWorkspaceSnapshot = {
    ...completed,
    captureState: { _tag: "recording", startedAt: "2026-10-15T00:00:00.000Z" },
    completedAt: null,
    id: AgentSessionId.make("agent-attach"),
    kind: "teaching",
    observation: {
      capturedAt: "",
      height: 800,
      id: "observed",
      image: null,
      nodes: [
        {
          bounds: { height: 400, width: 360, x: 0, y: 0 },
          covered: false,
          editable: false,
          name: "",
          password: false,
          role: "group",
          target: "@e0",
        },
        {
          bounds: { height: 40, width: 200, x: 80, y: 100 },
          covered: false,
          editable: false,
          name: "Banner",
          password: false,
          role: "button",
          target: "@e1",
        },
        {
          bounds: { height: 40, width: 200, x: 80, y: 600 },
          covered: false,
          editable: false,
          name: "Checkout",
          password: false,
          role: "button",
          target: "@e2",
        },
      ],
      width: 360,
    },
    phase: "running",
  };
  const mutate = vi.fn(() => true);
  const Harness = () => {
    const [state, setState] = useState<WorkspaceState>({
      attached: null,
      dismissedField: null,
      failure: null,
      highlightedComment: null,
      inputRefusal: null,
      instructing: false,
      instructionPending: false,
      picking: false,
      refusalDismissed: false,
      session,
      unavailable: false,
    });
    return (
      <AndroidSessionView
        mutate={mutate}
        notices={null}
        pending={false}
        session={session}
        setState={setState}
        state={state}
      />
    );
  };
  render(<Harness />, {
    wrapper: ({ children }) => (
      <RpcDependenciesProvider>{children}</RpcDependenciesProvider>
    ),
  });
  await user.click(screen.getByRole("button", { name: "Comment" }));
  const composer = screen.getByRole("dialog", { name: "Comment" });
  await user.click(
    within(composer).getByRole("button", { name: "Attach element" })
  );
  // The screen is a picker: an outline follows the pointer, and a click
  // attaches the smallest named element under it, never sending a touch.
  const picker = document.querySelector<HTMLElement>(
    '[data-slot="element-picker"]'
  );
  if (picker === null) {
    throw new Error("The element picker must cover the screen.");
  }
  vi.spyOn(picker, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ height: 800, width: 360, x: 0, y: 0 })
  );
  fireEvent.pointerMove(picker, { clientX: 100, clientY: 120 });
  expect(
    document.querySelector('[data-slot="screen-element-highlight"]')
  ).not.toBeNull();
  fireEvent.pointerUp(picker, { clientX: 100, clientY: 120 });
  expect(within(composer).getByText("Banner")).toBeVisible();
  expect(document.querySelector('[data-slot="element-picker"]')).toBeNull();
  // Change element from Screen elements, as a keyboard would; Escape cancels.
  await user.click(
    within(composer).getByRole("button", { name: "Change element" })
  );
  await user.keyboard("{Escape}");
  expect(document.querySelector('[data-slot="element-picker"]')).toBeNull();
  expect(within(composer).getByText("Banner")).toBeVisible();
  await user.click(
    within(composer).getByRole("button", { name: "Change element" })
  );
  await user.click(
    within(screen.getByRole("region", { name: "Screen elements" })).getByRole(
      "button",
      { name: "Attach Checkout" }
    )
  );
  expect(within(composer).getByText("Checkout")).toBeVisible();
  await user.type(
    within(composer).getByRole("textbox", { name: "Comment" }),
    "Checkout must stay enabled{Enter}"
  );
  expect(mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      _tag: "instruction",
      element: { observationId: "observed", target: "@e2" },
      text: "Checkout must stay enabled",
    })
  );
});

test("Teaching shows Start recording filled red, then the recording's clock in its chip", () => {
  const ready: AndroidWorkspaceSnapshot = {
    ...completed,
    captureState: { _tag: "setup", requestedAt: "2026-10-15T00:00:00.000Z" },
    completedAt: null,
    id: AgentSessionId.make("agent-teaching"),
    kind: "teaching",
    phase: "running",
  };
  const state: WorkspaceState = {
    attached: null,
    dismissedField: null,
    failure: null,
    highlightedComment: null,
    inputRefusal: null,
    instructing: false,
    instructionPending: false,
    picking: false,
    refusalDismissed: false,
    session: ready,
    unavailable: false,
  };
  const view = (session: AndroidWorkspaceSnapshot) => (
    <RpcDependenciesProvider>
      <AndroidSessionView
        mutate={vi.fn()}
        notices={null}
        pending={false}
        session={session}
        setState={vi.fn()}
        state={{ ...state, session }}
      />
    </RpcDependenciesProvider>
  );
  const { rerender } = render(view(ready));
  const status = screen.getByRole("region", { name: "Session status" });
  // Teaching has no Task details, and the Start action begins capture in red.
  expect(
    within(status).queryByRole("button", { name: "Task details" })
  ).toBeNull();
  expect(
    within(status).getByRole("button", { name: "Start recording" })
  ).toHaveClass("bg-status-recording");
  rerender(
    view({
      ...ready,
      captureState: {
        _tag: "recording",
        startedAt: "2026-10-15T00:00:00.000Z",
      },
    })
  );
  const timer = within(status).getByRole("timer");
  expect(timer).toHaveAccessibleName(
    /^Elapsed recording time (?:\d+:)?\d{2}:\d{2}$/u
  );
  expect(timer.closest('[data-slot="dock-state"]')).toHaveTextContent(
    /^Recording/u
  );
});
