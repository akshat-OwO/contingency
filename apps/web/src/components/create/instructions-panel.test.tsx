import type { RecordingSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { beforeEach, expect, test, vi } from "vitest";

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
  phase,
  recordedSteps: [
    {
      audits: [],
      id: "initial",
      preSteps: [],
      step: { type: "navigate", url: "https://example.com/start" },
    },
    {
      audits: [],
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
