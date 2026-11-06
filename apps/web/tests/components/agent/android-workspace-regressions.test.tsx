import { AgentSessionId, FlowName } from "@contingency/protocol";
import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { parseAndroidPermissionDecisions } from "@/components/agent/android-setup-state";
import {
  AndroidSessionView,
  AndroidEmptyState,
} from "@/components/agent/android-workspace";

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

test("offers paused and completed sessions without a selected Android session", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <AndroidEmptyState
      onBrowser={vi.fn()}
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
  const props = {
    mutate,
    notices: null,
    onBrowser: vi.fn(),
    pending: false,
    run: vi.fn(),
    session,
    setState: vi.fn(),
    state: {
      dismissedField: null,
      failure: null,
      instructing: false,
      instructionPending: false,
      refusalDismissed: false,
      session,
      setupOpen: false,
    },
  };
  const view = render(<AndroidSessionView {...props} />);
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
  expect(mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      _tag: "input",
      action: { _tag: "back" },
      observationId: "observed",
    })
  );
});

test("a refused pick is said in the dock and set aside while commenting", async () => {
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
  const state = {
    dismissedField: null,
    failure: null,
    instructing: false,
    instructionPending: false,
    refusalDismissed: false,
    session,
    setupOpen: false,
  };
  const props = {
    mutate: vi.fn(),
    notices: null,
    onBrowser: vi.fn(),
    pending: false,
    run: vi.fn(() =>
      Effect.fail("Nothing to activate there. No input was sent.")
    ),
    session,
    setState: vi.fn(),
    state,
  };
  const view = render(<AndroidSessionView {...props} />);
  await user.click(screen.getByRole("button", { name: "Screen elements" }));
  await user.click(
    await screen.findByRole("button", { name: "Activate Banner" })
  );
  const dock = screen.getByRole("region", { name: "Workspace dock" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Nothing to activate there. No input was sent."
  );
  expect(dock).toContainElement(screen.getByRole("alert"));
  view.rerender(
    <AndroidSessionView
      {...props}
      state={{ ...state, instructing: true, refusalDismissed: true }}
    />
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
