import type { RecordingSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createWorkspaceAtom } from "@/components/create/create-workspace-state";

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
    recordingAtom: Atom.make(Effect.succeed(rpcResult(null))),
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
    runRecordingStream: () => Effect.never,
  };
});

const { InstructionsPanel } =
  await import("@/components/create/instructions-panel");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

test("starts, pauses, and resumes a Recording through accessible controls", async () => {
  const user = userEvent.setup();
  render(
    <RegistryProvider
      initialValues={[
        [
          createWorkspaceAtom,
          {
            activeTabId: undefined,
            address: "https://example.com/start",
            recording: null,
            selectedSessionId: "create-checkout",
          },
        ],
      ]}
    >
      <InstructionsPanel />
    </RegistryProvider>
  );

  const start = screen.getByRole("button", { name: "Start Recording" });
  expect(start).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Flow title" }),
    "Checkout"
  );
  expect(start).toBeEnabled();
  await user.click(start);

  expect(await screen.findByText("active")).toBeVisible();
  expect(screen.getByText("2 Steps")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(await screen.findByText("paused")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(await screen.findByText("active")).toBeVisible();
});

test("reloads an incomplete Recording from a navigation checkpoint", async () => {
  const user = userEvent.setup();
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
      <InstructionsPanel />
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
      <InstructionsPanel />
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
