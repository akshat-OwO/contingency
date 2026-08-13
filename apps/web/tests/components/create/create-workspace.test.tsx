import type { RecordingSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createWorkspaceAtom } from "@/components/create/create-workspace-state";

const stream = vi.hoisted(() => ({
  recording: null as RecordingSnapshot | null,
  run: vi.fn(),
}));

vi.mock("@/components/create/browser-workspace", async () => {
  const { useAtom } = await import("@effect/atom-react");
  const { useEffect } = await import("react");
  const { createWorkspaceAtom: workspaceAtom, recordingLocksBrowser } =
    await import("@/components/create/create-workspace-state");
  return {
    BrowserWorkspace: () => {
      const [workspace, setWorkspace] = useAtom(workspaceAtom);
      useEffect(() => {
        if (workspace.selectedSessionId !== undefined) {
          return;
        }
        setWorkspace((current) => ({
          ...current,
          activeTabId: "tab-1",
          address: "https://example.com/start",
          selectedSessionId: "create-checkout",
        }));
      }, [setWorkspace, workspace.selectedSessionId]);
      return (
        <section
          aria-label="Browser workspace"
          data-address={workspace.address}
          data-locked={recordingLocksBrowser(workspace.recording)}
          data-session={workspace.selectedSessionId}
        />
      );
    },
  };
});

vi.mock("@/components/ui/resizable", () => ({
  ResizableHandle: () => <hr />,
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const makeSnapshot = (
  phase: RecordingSnapshot["phase"]
): RecordingSnapshot => ({
  captureMode: "ordinary",
  flow: {
    steps: [
      { type: "navigate", url: "https://example.com/start" },
      {
        offsetX: 4,
        offsetY: 8,
        selectors: ["aria/Continue"],
        type: "click",
      },
    ],
    title: "Checkout",
  },
  initialUrl: "https://example.com/start",
  ...(phase === "incomplete"
    ? { incompleteReason: "The original capture connection failed." }
    : {}),
  phase,
  recordedSteps: [
    {
      id: "initial",
      preSteps: [],
      step: { type: "navigate", url: "https://example.com/start" },
    },
    {
      id: "continue",
      preSteps: [],
      step: {
        offsetX: 4,
        offsetY: 8,
        selectors: ["aria/Continue"],
        type: "click",
      },
    },
  ],
  revision: 1,
  sessionId: "create-checkout",
  tabId: "tab-1",
  undoAvailable: false,
});

const rpcResult = (recording: RecordingSnapshot | null) => ({
  data: { recording },
  type: "recording.result" as const,
});

vi.mock("@/lib/rpc", () => {
  const mutation = (phase: RecordingSnapshot["phase"]) =>
    Atom.fn(() => Effect.succeed(rpcResult(makeSnapshot(phase))));

  // Match the production RPC module's authoring groups.
  // oxlint-disable-next-line eslint/sort-keys
  return {
    recordingAtom: Atom.make({
      _tag: "Success" as const,
      get value() {
        return rpcResult(stream.recording);
      },
    }),
    recordingAuditMutation: mutation("active"),
    recordingCaptureCancelMutation: mutation("active"),
    recordingDiscardMutation: Atom.fn(() =>
      Effect.succeed({ data: {}, type: "recording.discarded" as const })
    ),
    recordingFinishMutation: mutation("finished"),
    recordingPauseMutation: mutation("paused"),
    recordingPreStepMutation: mutation("active"),
    recordingPreStepConditionMutation: mutation("active"),
    recordingRecoverMutation: mutation("active"),
    recordingResumeMutation: mutation("active"),
    recordingSecretBindMutation: mutation("active"),
    recordingSecretRenameMutation: mutation("active"),
    recordingStartMutation: mutation("active"),
    recordingStepDeleteMutation: mutation("active"),
    recordingStepUndoMutation: mutation("active"),
    recordingTitleMutation: mutation("active"),
    runRecordingStream: (onEvent: (recording: RecordingSnapshot) => unknown) =>
      stream.run(onEvent),
  };
});

const { CreateWorkspace } =
  await import("@/components/create/create-workspace");

beforeEach(() => {
  vi.clearAllMocks();
  stream.recording = null;
  stream.run.mockReturnValue(Effect.never);
});

afterEach(cleanup);

test("starts a Recording only after browser and title prerequisites", async () => {
  const user = userEvent.setup();
  render(
    <RegistryProvider>
      <CreateWorkspace />
    </RegistryProvider>
  );

  const start = screen.getByRole("button", { name: "Start Recording" });
  expect(start).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Browser workspace" })
    ).toHaveAttribute("data-session", "create-checkout")
  );
  await user.type(
    screen.getByRole("textbox", { name: "Flow title" }),
    "Checkout"
  );
  expect(screen.getByRole("button", { name: "Start Recording" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Start Recording" }));

  expect(await screen.findByText("active")).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Browser workspace" })
  ).toHaveAttribute("data-locked", "true");
});

test("locks the composed browser while pausing and resuming a Recording", async () => {
  const user = userEvent.setup();
  stream.recording = makeSnapshot("active");
  render(
    <RegistryProvider
      initialValues={[
        [
          createWorkspaceAtom,
          {
            activeTabId: "tab-1",
            address: "https://example.com/start",
            recording: makeSnapshot("active"),
            selectedSessionId: "create-checkout",
          },
        ],
      ]}
    >
      <CreateWorkspace />
    </RegistryProvider>
  );

  expect(
    screen.getByRole("region", { name: "Browser workspace" })
  ).toHaveAttribute("data-session", "create-checkout");
  expect(
    screen.getByRole("region", { name: "Browser workspace" })
  ).toHaveAttribute("data-address", "https://example.com/start");
  expect(screen.getByText("active")).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Browser workspace" })
  ).toHaveAttribute("data-locked", "true");
  expect(screen.getByText("2 Steps")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(await screen.findByText("paused")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(await screen.findByText("active")).toBeVisible();
});

test("reloads an incomplete Recording from a navigation checkpoint", async () => {
  const user = userEvent.setup();
  stream.recording = makeSnapshot("incomplete");
  render(
    <RegistryProvider
      initialValues={[
        [
          createWorkspaceAtom,
          {
            activeTabId: "tab-1",
            address: "https://example.com/start",
            recording: makeSnapshot("incomplete"),
            selectedSessionId: "create-checkout",
          },
        ],
      ]}
    >
      <CreateWorkspace />
    </RegistryProvider>
  );

  expect(screen.getByText("Recording is incomplete")).toBeVisible();
  expect(
    screen.getByText(/Actions performed after the failure/u)
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Reload & Resume" }));
  expect(await screen.findByText("active")).toBeVisible();
});

test("renders Flow Pre-steps as cards and Audits as ordered Steps", async () => {
  const user = userEvent.setup();
  const base = makeSnapshot("active");
  const preStep = {
    id: "dismiss-banner",
    step: {
      offsetX: 2,
      offsetY: 3,
      selectors: ["aria/Close banner"],
      type: "click" as const,
    },
    when: {
      selectors: ["aria/Banner"],
      type: "selectorVisible" as const,
    },
  };
  const auditStep = {
    id: "accessibility-audit",
    preSteps: [],
    step: {
      name: "contingency.audit" as const,
      parameters: { kind: "accessibility" as const },
      type: "customStep" as const,
    },
  };
  const recording: RecordingSnapshot = {
    ...base,
    flow: {
      contingency: { preSteps: [preStep] },
      steps: [...base.flow.steps, auditStep.step],
      title: base.flow.title,
    },
    recordedSteps: [...base.recordedSteps, auditStep],
  };
  stream.recording = recording;

  render(
    <RegistryProvider
      initialValues={[
        [
          createWorkspaceAtom,
          {
            activeTabId: "tab-1",
            address: "https://example.com/start",
            recording,
            selectedSessionId: "create-checkout",
          },
        ],
      ]}
    >
      <CreateWorkspace />
    </RegistryProvider>
  );

  const preSteps = screen.getByRole("region", { name: "Flow Pre-steps" });
  expect(within(preSteps).getByText("Click element")).toBeVisible();
  expect(within(preSteps).getByText("aria/Close banner")).toBeVisible();
  await user.hover(
    screen.getByRole("button", { name: "About Flow Pre-steps" })
  );
  expect(
    await screen.findByText(
      "Runs before every Step after the starting navigation."
    )
  ).toBeVisible();

  expect(screen.getByText("Accessibility Audit")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add accessibility Audit" })
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Add performance Audit" })
  ).toBeEnabled();
});

test("surfaces a terminal Recording stream failure", async () => {
  stream.run.mockReturnValue(Effect.fail(new Error("Recorder stream failed")));

  render(
    <RegistryProvider>
      <CreateWorkspace />
    </RegistryProvider>
  );

  expect(
    await screen.findByText("Recording updates disconnected")
  ).toBeVisible();
  expect(screen.getByText("Recorder stream failed")).toBeVisible();
});

test("does not finish a Flow whose only authored Step is an Audit", () => {
  const active = makeSnapshot("active");
  const auditOnly: RecordingSnapshot = {
    ...active,
    flow: {
      ...active.flow,
      steps: [
        active.flow.steps[0] ?? {
          type: "navigate",
          url: "https://example.com/start",
        },
        {
          name: "contingency.audit",
          parameters: { kind: "accessibility" },
          type: "customStep",
        },
      ],
    },
    recordedSteps: [
      active.recordedSteps[0] ?? {
        id: "initial",
        preSteps: [],
        step: { type: "navigate", url: "https://example.com/start" },
      },
      {
        id: "audit",
        preSteps: [],
        step: {
          name: "contingency.audit",
          parameters: { kind: "accessibility" },
          type: "customStep",
        },
      },
    ],
  };
  stream.recording = auditOnly;

  render(
    <RegistryProvider>
      <CreateWorkspace />
    </RegistryProvider>
  );

  expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled();
});
