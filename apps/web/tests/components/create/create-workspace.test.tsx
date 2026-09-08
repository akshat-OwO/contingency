import type { RecordingSnapshot } from "@contingency/protocol";
import {
  BrowserTabId,
  Flow,
  resolveUserAgent,
  SessionId,
} from "@contingency/protocol";
import { RegistryProvider, useAtom } from "@effect/atom-react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CreateWorkspace } from "@/components/create/create-workspace";
import type { CreateWorkspaceComponents } from "@/components/create/create-workspace";
import {
  createWorkspaceAtom,
  recordingLocksBrowser,
} from "@/components/create/create-workspace-state";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

interface RecordingStreamState {
  effect: Effect.Effect<never, Error>;
  recording: RecordingSnapshot | null;
}

const stream: RecordingStreamState = {
  effect: Effect.never,
  recording: null,
};

const rpc = vi.hoisted(() => ({
  bindVariable: vi.fn(),
  bindVariableResult: null,
  condition: vi.fn(),
  conditionResult: null,
  conditionUrl: vi.fn(),
  conditionUrlResult: null,
  deleteStep: vi.fn(),
  deleteStepResult: null,
  discard: vi.fn(),
  preStep: vi.fn(),
  preStepResult: null,
  renameVariable: vi.fn(),
  renameVariableResult: null,
  undoDelete: vi.fn(),
  undoDeleteResult: null,
}));

const sessionId = SessionId.make("create-checkout");
const tabId = BrowserTabId.make("tab-1");

const TestBrowser = () => {
  const [workspace, setWorkspace] = useAtom(createWorkspaceAtom);
  useEffect(() => {
    if (workspace.selectedSessionId !== undefined) {
      return;
    }
    setWorkspace((current) => ({
      ...current,
      activeTabId: tabId,
      address: "https://example.com/start",
      selectedSessionId: sessionId,
    }));
  }, [setWorkspace, workspace.selectedSessionId]);
  return (
    <section
      aria-label="Browser workspace"
      data-address={workspace.address}
      data-locked={recordingLocksBrowser(
        workspace.recording,
        workspace.selectedSessionId
      )}
      data-session={workspace.selectedSessionId}
    />
  );
};

const testComponents: CreateWorkspaceComponents = {
  Browser: TestBrowser,
  Handle: () => <hr />,
  Panel: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
  PanelGroup: ({ children }: { readonly children: ReactNode }) => (
    <div>{children}</div>
  ),
};

const makeSnapshot = (phase: RecordingSnapshot["phase"]): RecordingSnapshot => {
  const snapshot = {
    captureMode: "ordinary" as const,
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
  };
  return phase === "incomplete"
    ? {
        ...snapshot,
        incompleteReason: "The original capture connection failed.",
      }
    : snapshot;
};

const rpcResult = (recording: RecordingSnapshot | null) => ({
  data: { recording },
  type: "recording.result",
});

const rpcOverrides = (() => {
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
      _tag: "Success",
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
        type: "recording.discarded",
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
    recordingPreStepConditionUrlMutation: controlledMutation(
      rpc.conditionUrl,
      () => rpc.conditionUrlResult
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
    runRecordingStream: (
      _onEvent: (recording: RecordingSnapshot) => Effect.Effect<void>
    ) => stream.effect,
  };
})();

const TestWorkspace = () => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <CreateWorkspace components={testComponents} />
  </RpcDependenciesProvider>
);

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
      <TestWorkspace />
    </RegistryProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.bindVariableResult = null;
  rpc.conditionResult = null;
  rpc.conditionUrlResult = null;
  rpc.deleteStepResult = null;
  rpc.preStepResult = null;
  rpc.renameVariableResult = null;
  rpc.undoDeleteResult = null;
  stream.recording = null;
  stream.effect = Effect.never;
});

afterEach(cleanup);

test("starts a Recording only after browser and title prerequisites", async () => {
  const user = userEvent.setup();
  render(
    <RegistryProvider>
      <TestWorkspace />
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
      <TestWorkspace />
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
      <TestWorkspace />
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
      type: "click",
    },
    when: {
      target: [{ kind: "role", name: "Banner", role: "banner" }],
      type: "selectorVisible",
    },
  };
  const auditStep = {
    id: "accessibility-audit",
    preSteps: [],
    step: {
      kind: "accessibility",
      type: "audit",
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
      <TestWorkspace />
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
  stream.effect = Effect.fail(new Error("Recorder stream failed"));

  render(
    <RegistryProvider>
      <TestWorkspace />
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
      <TestWorkspace />
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

test("arms explicit Flow Pre-step capture and picks a visible condition", async () => {
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
      type: "click",
    },
    when: {
      target: [{ kind: "role", name: "Dialog", role: "dialog" }],
      type: "selectorVisible",
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
  await user.click(
    await screen.findByRole("menuitem", {
      name: "When an element is visible",
    })
  );
  expect(rpc.condition).toHaveBeenCalledOnce();
  expect(rpc.condition.mock.calls[0]?.[0]?.payload).toMatchObject({
    data: { index: 0, kind: "selectorVisible", scope: "flow" },
  });
  expect(await screen.findByText("Pick the condition element")).toBeVisible();
});

test("arms a hidden-element condition and prompts for it", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  const bannerPreStep: RecordingSnapshot["flow"]["preSteps"] = [
    {
      id: "clear-banner",
      step: {
        target: [{ kind: "role", name: "Dismiss", role: "button" }],
        type: "click",
      },
      when: {
        target: [{ kind: "role", name: "Banner", role: "banner" }],
        type: "selectorHidden",
      },
    },
  ];
  rpc.conditionResult = {
    ...active,
    captureMode: "conditionPicker",
    flow: { ...active.flow, preSteps: bannerPreStep },
  };
  renderRecording({
    ...active,
    flow: { ...active.flow, preSteps: bannerPreStep },
  });

  await user.click(screen.getByRole("button", { name: "Pick condition" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: "When an element is hidden",
    })
  );
  expect(rpc.condition).toHaveBeenCalledOnce();
  expect(rpc.condition.mock.calls[0]?.[0]?.payload).toMatchObject({
    data: { kind: "selectorHidden", scope: "flow" },
  });
  expect(await screen.findByText("Pick the hidden element")).toBeVisible();
});

test("authors a urlMatches condition from a typed pattern", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  const checkoutPreStep: RecordingSnapshot["flow"]["preSteps"] = [
    {
      id: "checkout-only",
      step: {
        target: [{ kind: "role", name: "Dismiss", role: "button" }],
        type: "click",
      },
      when: {
        target: [{ kind: "role", name: "Banner", role: "banner" }],
        type: "selectorVisible",
      },
    },
  ];
  const withPreStep = {
    ...active,
    flow: { ...active.flow, preSteps: checkoutPreStep },
  };
  rpc.conditionUrlResult = {
    ...withPreStep,
    flow: {
      ...withPreStep.flow,
      preSteps: [
        {
          ...checkoutPreStep[0],
          id: "checkout-only",
          when: { pattern: "/checkout$", type: "urlMatches" },
        },
      ],
    },
  };
  renderRecording(withPreStep);

  await user.click(screen.getByRole("button", { name: "Pick condition" }));
  await user.click(
    await screen.findByRole("menuitem", {
      name: "When the URL matches…",
    })
  );
  const input = screen.getByRole("textbox", { name: "URL pattern" });
  await user.type(input, "/checkout$");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(rpc.conditionUrl).toHaveBeenCalledOnce();
  expect(rpc.conditionUrl.mock.calls[0]?.[0]?.payload).toMatchObject({
    data: { index: 0, pattern: "/checkout$", scope: "flow" },
  });
});

test("shows which Page a Step beyond the first acts on", () => {
  const active = makeSnapshot("active");
  const popupClick = {
    id: "popup-continue",
    preSteps: [],
    step: {
      page: 1,
      target: [{ kind: "role", name: "Pay now", role: "button" }],
      type: "click",
    },
  };
  const recording: RecordingSnapshot = {
    ...active,
    flow: {
      ...active.flow,
      steps: [...active.flow.steps, popupClick.step],
    },
    recordedSteps: [...active.recordedSteps, popupClick],
  };
  renderRecording(recording);

  // The first Page names nothing; a later Step names its Page by the order it
  // opened, matching the index the Flow document carries.
  expect(screen.queryByText("Page 0")).toBeNull();
  expect(screen.getByText("Page 1")).toBeVisible();
});

test("names a container Scroll by its target", () => {
  const active = makeSnapshot("active");
  const containerScroll = {
    id: "results-scroll",
    preSteps: [],
    step: {
      deltaY: 200,
      target: [{ kind: "role", name: "Results", role: "region" }],
      type: "scroll",
    },
  };
  const recording: RecordingSnapshot = {
    ...active,
    flow: {
      ...active.flow,
      steps: [...active.flow.steps, containerScroll.step],
    },
    recordedSteps: [...active.recordedSteps, containerScroll],
  };
  renderRecording(recording);

  expect(screen.getByText('Scroll region "Results"')).toBeVisible();
  expect(screen.getByText("Δ (0, 200)")).toBeVisible();
});

test("renames and rebinds Variables", async () => {
  const user = userEvent.setup();
  const active = makeSnapshot("active");
  const changeStep = {
    id: "email-change",
    preSteps: [],
    step: {
      target: [{ kind: "label", label: "Email" }],
      type: "change",
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

test("downloads a migrated browser identity in the normalized shape", async () => {
  const user = userEvent.setup();
  const userAgent = resolveUserAgent("chrome-android-mobile", "141");
  const migrated = Schema.decodeUnknownSync(Flow)({
    emulation: { userAgent },
    steps: [{ type: "navigate", url: "https://example.com/start" }],
    title: "Older mobile Flow",
  });
  const finished = {
    ...makeSnapshot("finished"),
    downloadName: "older-mobile.json",
    flow: migrated,
  };
  let downloadedBlob: Blob | undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob;
    return "blob:flow";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => null);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderRecording(finished);

  await user.click(
    screen.getByRole("button", { name: "Download older-mobile.json" })
  );
  const downloaded = JSON.parse((await downloadedBlob?.text()) ?? "null");

  expect(downloaded.emulation?.browser?.mobile).toBe(true);
  expect(downloaded.emulation?.userAgent).toBeUndefined();
});
