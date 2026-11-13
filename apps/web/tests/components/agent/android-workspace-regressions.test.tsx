import { AgentSessionId, FlowName } from "@contingency/protocol";
import type {
  AndroidWorkspaceSnapshot,
  NativeForward,
} from "@contingency/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
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
      onOpen={vi.fn()}
      onSelect={onSelect}
      sessions={[paused, completed]}
    />
  );
  await user.tab();
  expect(
    screen.getByRole("combobox", { name: "Android Agent Session" })
  ).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(
    await screen.findByRole("option", { name: "paused-checkout · Android Run" })
  ).toBeVisible();
  await user.keyboard("{End}{Enter}");
  expect(onSelect).toHaveBeenCalledWith(completed.id);
});

test("says a linked session is gone without offering a session selector", () => {
  render(
    <AndroidEmptyState
      onOpen={vi.fn()}
      onSelect={vi.fn()}
      sessions={[]}
      unavailable
    />
  );
  expect(
    screen.getByText("The session this link named is no longer available.")
  ).toBeVisible();
  expect(
    screen.queryByRole("combobox", { name: "Android Agent Session" })
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Open Android session" })
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

test("Confirmation keeps the device healthy and Take control enables Back", async () => {
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
      dismissedField: null,
      failure: null,
      inputRefusal: null,
      instructing: false,
      instructionPending: false,
      refusalDismissed: false,
      session,
      setupOpen: false,
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
  expect(screen.getByRole("button", { name: "Android Back" })).toBeDisabled();
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
  // Back is Forwarded Input: the GoBack key goes straight to the device.
  await waitFor(() =>
    expect(forwarded.flatMap((request) => request.inputs)).toEqual([
      expect.objectContaining({ _tag: "key", action: "down", key: "GoBack" }),
      expect.objectContaining({ _tag: "key", action: "up", key: "GoBack" }),
    ])
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
    dismissedField: null,
    failure: null,
    inputRefusal: null,
    instructing: false,
    instructionPending: false,
    refusalDismissed: false,
    session,
    setupOpen: false,
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
  const dock = screen.getByRole("region", { name: "Workspace dock" });
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
