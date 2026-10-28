import { AgentSessionId, FlowSkillName } from "@contingency/protocol";
import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  flowSkillName: FlowSkillName.make("finished-checkout"),
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
  flowSkillName: FlowSkillName.make("paused-checkout"),
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
