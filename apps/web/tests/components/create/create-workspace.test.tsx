import type { RecordingSnapshot } from "@contingency/protocol";
import { BrowserTabId, SessionId } from "@contingency/protocol";
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

const rpc = vi.hoisted(() => ({
  bindVariable: vi.fn(),
  bindVariableResult: null as RecordingSnapshot | null,
  condition: vi.fn(),
  conditionResult: null as RecordingSnapshot | null,
  deleteStep: vi.fn(),
  deleteStepResult: null as RecordingSnapshot | null,
  discard: vi.fn(),
  preStep: vi.fn(),
  preStepResult: null as RecordingSnapshot | null,
  renameVariable: vi.fn(),
  renameVariableResult: null as RecordingSnapshot | null,
  undoDelete: vi.fn(),
  undoDeleteResult: null as RecordingSnapshot | null,
}));

const sessionId = SessionId.make("create-checkout");
const tabId = BrowserTabId.make("tab-1");

vi.mock("@/components/create/browser-workspace", async () => {
  const { BrowserTabId: TabId, SessionId: BrowserSessionId } =
    await import("@contingency/protocol");
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
          activeTabId: TabId.make("tab-1"),
          address: "https://example.com/start",
          selectedSessionId: BrowserSessionId.make("create-checkout"),
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
        target: [{ kind: "role", name: "Continue", role: "button" }],
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
        target: [{ kind: "role", name: "Continue", role: "button" }],
        type: "click",
      },
    },
  ],
  revision: 1,
  sessionId,
  tabId,
  undoAvailable: false,
});

const rpcResult = (recording: RecordingSnapshot | null) => ({
  data: { recording },
  type: "recording.result" as const,
});

vi.mock("@/lib/rpc", () => {
  const mutation = (phase: RecordingSnapshot["phase"]) =>
    Atom.fn(() => Effect.succeed(rpcResult(makeSnapshot(phase))));
  const controlledMutation = (
    call: ReturnType<typeof vi.fn>,
    result: () => RecordingSnapshot | null
  ) =>
    Atom.fn((request) => {
      call(request);
      return Effect.succeed(rpcResult(result() ?? makeSnapshot("active")));
    });

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
    recordingDiscardMutation: Atom.fn((request) => {
      rpc.discard(request);
      return Effect.succeed({
        data: {},
        type: "recording.discarded" as const,
      });
    }),
    recordingFinishMutation: mutation("finished"),
    recordingHoverArmMutation: mutation("active"),
    recordingPauseMutation: mutation("paused"),
    recordingPreStepMutation: controlledMutation(
      rpc.preStep,
      () => rpc.preStepResult
    ),
    recordingPreStepConditionMutation: controlledMutation(
      rpc.condition,
      () => rpc.conditionResult
    ),
    recordingRecoverMutation: mutation("active"),
    recordingResumeMutation: mutation("active"),
    recordingVariableBindMutation: controlledMutation(
      rpc.bindVariable,
      () => rpc.bindVariableResult
    ),
    recordingVariableRenameMutation: controlledMutation(
      rpc.renameVariable,
      () => rpc.renameVariableResult
    ),
    recordingStartMutation: mutation("active"),
    recordingStepDeleteMutation: controlledMutation(
      rpc.deleteStep,
      () => rpc.deleteStepResult
    ),
    recordingStepUndoMutation: controlledMutation(
      rpc.undoDelete,
      () => rpc.undoDeleteResult
    ),
    recordingTitleMutation: mutation("active"),
    runRecordingStream: (onEvent: (recording: RecordingSnapshot) => unknown) =>
      stream.run(onEvent),
  };
});

const { CreateWorkspace } =
  await import("@/components/create/create-workspace");

const renderRecording = (recording: RecordingSnapshot) => {
  stream.recording = recording;
  return render(
    <RegistryProvider
      initialValues={[
        [
          createWorkspaceAtom,
          {
            activeTabId: recording.tabId,
            address: recording.initialUrl,
            recording,
            selectedSessionId: recording.sessionId,
          },
        ],
      ]}
    >
      <CreateWorkspace />
    </RegistryProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.bindVariableResult = null;
  rpc.conditionResult = null;
  rpc.deleteStepResult = null;
  rpc.preStepResult = null;
  rpc.renameVariableResult = null;
  rpc.undoDeleteResult = null;
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
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start Recording" })
    ).toBeEnabled()
  );
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
            activeTabId: tabId,
            address: "https://example.com/start",
            recording: makeSnapshot("active"),
            selectedSessionId: sessionId,
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
            activeTabId: tabId,
            address: "https://example.com/start",
            recording: makeSnapshot("incomplete"),
            selectedSessionId: sessionId,
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
      target: [{ kind: "role", name: "Close banner", role: "button" }],
      type: "click" as const,
    },
    when: {
      target: [{ kind: "role", name: "Banner", role: "banner" }],
      type: "selectorVisible" as const,
    },
  };
  const auditStep = {
    id: "accessibility-audit",
    preSteps: [],
    step: {
      kind: "accessibility" as const,
      type: "audit" as const,
    },
  };
  const recording: RecordingSnapshot = {
    ...base,
    flow: {
      preSteps: [preStep],
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
            activeTabId: tabId,
            address: "https://example.com/start",
            recording,
            selectedSessionId: sessionId,
          },
        ],
      ]}
    >
      <CreateWorkspace />
    </RegistryProvider>
  );

  const preSteps = screen.getByRole("region", { name: "Flow Pre-steps" });
  expect(within(preSteps).getByText("Click element")).toBeVisible();
  expect(within(preSteps).getByText('button "Close banner"')).toBeVisible();
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
  // Performance is not an Audit kind; it is a toggle on a navigating Step.
  expect(
    screen.queryByRole("button", { name: "Add performance Audit" })
  ).toBeNull();
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
          kind: "accessibility",
          type: "audit",
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
          kind: "accessibility",
          type: "audit",
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

test("deletes and restores a Step through one-level undo", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  const [initial] = active.recordedSteps;
  const [initialFlowStep] = active.flow.steps;
  if (initial === undefined || initialFlowStep === undefined) {
    throw new Error("The Recording fixture requires an initial Step.");
  }
  rpc.deleteStepResult = {
    ...active,
    flow: { ...active.flow, steps: [initialFlowStep] },
    recordedSteps: [initial],
    undoAvailable: true,
  };
  rpc.undoDeleteResult = active;
  renderRecording(active);

  await user.click(screen.getByRole("button", { name: "Delete Step 2" }));
  expect(await screen.findByText("1 Steps")).toBeVisible();
  expect(rpc.deleteStep).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Undo delete" }));
  expect(await screen.findByText("2 Steps")).toBeVisible();
  expect(rpc.undoDelete).toHaveBeenCalledOnce();
});

test("arms explicit Flow Pre-step capture and condition picking", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  rpc.preStepResult = { ...active, captureMode: "flowPreStep" };
  const view = renderRecording(active);

  await user.click(screen.getByRole("button", { name: "Add Flow Pre-step" }));
  expect(await screen.findByText("Record the next Pre-step")).toBeVisible();
  expect(rpc.preStep).toHaveBeenCalledOnce();

  view.unmount();
  const preStep = {
    id: "dismiss-dialog",
    step: {
      target: [{ kind: "role", name: "Close dialog", role: "button" }],
      type: "click" as const,
    },
    when: {
      target: [{ kind: "role", name: "Dialog", role: "dialog" }],
      type: "selectorVisible" as const,
    },
  };
  const withPreStep: RecordingSnapshot = {
    ...active,
    flow: {
      ...active.flow,
      preSteps: [preStep],
    },
  };
  rpc.conditionResult = { ...withPreStep, captureMode: "conditionPicker" };
  renderRecording(withPreStep);
  await user.click(screen.getByRole("button", { name: "Pick condition" }));
  expect(await screen.findByText("Pick the condition element")).toBeVisible();
  expect(rpc.condition).toHaveBeenCalledOnce();
});

test("renames and rebinds Variables", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  const changeStep = {
    id: "email-change",
    preSteps: [],
    step: {
      target: [{ kind: "label", label: "Email" }],
      type: "change" as const,
      value: "{{ACCOUNT}}",
    },
    variable: "ACCOUNT",
  };
  const recording: RecordingSnapshot = {
    ...active,
    flow: {
      ...active.flow,
      steps: [...active.flow.steps, changeStep.step],
      variables: [
        { name: "ACCOUNT", runtime: true, secret: true },
        { name: "LOGIN", runtime: true, secret: true },
      ],
    },
    recordedSteps: [...active.recordedSteps, changeStep],
  };
  rpc.bindVariableResult = recording;
  rpc.renameVariableResult = recording;
  renderRecording(recording);

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Variable for Step 3" }),
    "LOGIN"
  );
  expect(rpc.bindVariable).toHaveBeenCalledOnce();
  const rename = screen.getByRole("textbox", { name: "Rename ACCOUNT" });
  await user.clear(rename);
  await user.type(rename, "CUSTOMER_EMAIL");
  await user.tab();
  expect(rpc.renameVariable).toHaveBeenCalledOnce();
});

test("confirms discarding an authored finished Flow before replacement", async () => {
  const user = userEvent.setup();
  const finished = {
    ...makeSnapshot("finished"),
    downloadName: "example-checkout.json",
  };
  renderRecording(finished);

  await user.click(screen.getByRole("button", { name: "Discard" }));
  expect(rpc.discard).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Confirm discard" }));
  expect(rpc.discard).toHaveBeenCalledOnce();
  expect(
    await screen.findByRole("button", { name: "Start Recording" })
  ).toBeVisible();
});

test("downloads only the finished Flow with its normalized filename", async () => {
  const user = userEvent.setup();
  const finished = {
    ...makeSnapshot("finished"),
    downloadName: "example-checkout.json",
  };
  let downloadedName: string | undefined;
  let downloadedBlob: Blob | undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob;
    return "blob:flow";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => null);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function captureDownload(this: HTMLAnchorElement) {
      downloadedName = this.download;
    }
  );
  renderRecording(finished);

  await user.click(
    screen.getByRole("button", { name: "Download example-checkout.json" })
  );
  expect(downloadedName).toBe("example-checkout.json");
  expect(downloadedBlob).toBeDefined();
  const downloadedText = await downloadedBlob?.text();
  expect(downloadedText).toBe(`${JSON.stringify(finished.flow, null, 2)}\n`);
});
