import { RegistryProvider } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Cause } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { DryRunSummaryView } from "@/components/agent/dry-run-summary";
import { RunSummaryView, RunViewer } from "@/components/agent/run-view";
import { teachingRecordingPresentation } from "@/components/agent/teaching-recording-state";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { routeTree } from "@/routeTree.gen";

const rpc = vi.hoisted(() => ({
  summaryResult: { _tag: "Initial", waiting: true } satisfies unknown,
}));

const rpcOverrides = {
  agentRunSummaryAtom: () => Atom.make(() => rpc.summaryResult),
};

const TestRegistry = ({ children }: { readonly children: ReactNode }) => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <RegistryProvider>{children}</RegistryProvider>
  </RpcDependenciesProvider>
);

const step = {
  assessment: null,
  attempts: 0,
  confirmation: false,
  description: "Open the catalogue.",
  doneWhen: "the catalogue lists at least one product.",
  endedAt: null,
  execution: "pending",
  index: 0,
  name: "Open the catalogue",
  startedAt: null,
};

const run = {
  activeStepIndex: 1,
  assessmentCounts: { blocked: 0, inconclusive: 0, notWorking: 1, working: 1 },
  attribution: {
    clientName: "run-agent",
    clientVersion: "2.0.0",
    reportedMetadataVerified: false,
    reportedModel: "a-model",
    reportedProvider: "a-provider",
  },
  coverage: { complete: false, executed: 2, total: 3, unexecuted: 1 },
  endedAt: null,
  flowSkillName: "browse-catalogue",
  inputs: [{ name: "product", value: "Mug" }],
  lastAgentActivityAt: "2026-09-04T00:01:00.000Z",
  outcome: null,
  runId: "agentrun-one",
  startedAt: "2026-09-04T00:00:00.000Z",
  steps: [
    {
      ...step,
      assessment: {
        attempts: 2,
        evidence: [{ id: "snapshot-1", kind: "snapshot" }],
        explanation: "The catalogue listed the expected products.",
        outcome: "working",
        submittedAt: "2026-09-04T00:00:30.000Z",
      },
      execution: "assessed",
    },
    {
      ...step,
      description: "Add the product to the basket.",
      execution: "active",
      index: 1,
      name: "Add to basket",
    },
    {
      ...step,
      description: "Complete the purchase.",
      execution: "unexecuted",
      index: 2,
      name: "Check out",
    },
  ],
  title: "Buy one product",
  variables: [],
};

const summary = {
  assessmentCounts: { blocked: 0, inconclusive: 0, notWorking: 1, working: 1 },
  attribution: run.attribution,
  coverage: run.coverage,
  endedAt: "2026-09-04T00:02:00.000Z",
  flowSkillName: "browse-catalogue",
  inputs: run.inputs,
  outcome: "ended-early",
  runId: "agentrun-one",
  schemaVersion: 2,
  sessionId: "agent-one",
  startedAt: "2026-09-04T00:00:00.000Z",
  steps: run.steps,
  summary: "The basket never accepted the product.",
  timeline: [],
  title: "Buy one product",
  tracePath: "run.trace.zip",
  videoPath: "run.webm",
};

const successfulSummary = {
  _tag: "Success",
  value: {
    data: { summary, viewUrl: "http://127.0.0.1:7777/?run=agentrun-one" },
  },
  waiting: false,
};

// The component takes the protocol shapes; the fixtures above are the same
// values without their branded identifiers.
const asSummary = summary;

afterEach(() => {
  cleanup();
  rpc.summaryResult = { _tag: "Initial", waiting: true };
});

test("shows the ordered Agent Steps and what each one produced", () => {
  render(
    <TestRegistry>
      <RunSummaryView summary={asSummary} />
    </TestRegistry>
  );
  expect(screen.getByRole("list", { name: "Agent Steps" })).toBeVisible();
  expect(screen.getByText("1. Open the catalogue")).toBeVisible();
  expect(
    screen.getByText("The catalogue listed the expected products.")
  ).toBeVisible();
  expect(screen.getByText("Not executed")).toBeVisible();
});

test("reports assessment counts separately from coverage", () => {
  render(
    <TestRegistry>
      <RunSummaryView summary={asSummary} />
    </TestRegistry>
  );
  expect(
    screen.getByText("Incomplete · 2 of 3 Agent Steps executed")
  ).toBeVisible();
  expect(
    screen.getByText("1 working · 1 not working · 0 inconclusive · 0 blocked")
  ).toBeVisible();
});

test("embeds the local Run video in the summary of a finished Run", () => {
  render(
    <TestRegistry>
      <RunSummaryView summary={asSummary} />
    </TestRegistry>
  );
  expect(screen.getByText("Run Summary")).toBeVisible();
  const video = screen.getByLabelText("Recorded Run video");
  expect(video).toHaveAttribute("src", "/agent-runs/agentrun-one/video");
});

test("opens persisted Run evidence in the Workspace route without a live session", async () => {
  rpc.summaryResult = successfulSummary;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/?run=agentrun-one"] }),
    routeTree,
  });
  await router.load();
  render(
    <TestRegistry>
      <RouterProvider router={router} />
    </TestRegistry>
  );
  expect(
    screen.getByRole("heading", { level: 1, name: "Run Summary" })
  ).toBeVisible();
  expect(
    screen.getByText(
      "A read-only view of persisted evidence. No browser was reopened."
    )
  ).toBeVisible();
  expect(screen.getByText("ended-early")).toBeVisible();
  expect(screen.getByRole("link", { name: "Workspace" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  expect(
    screen.queryByRole("combobox", { name: "Agent Session" })
  ).not.toBeInTheDocument();
  for (const name of ["Create", "Audit", "Agent"]) {
    expect(
      screen.queryByRole("link", { exact: true, name })
    ).not.toBeInTheDocument();
  }
});

test("explains when a persisted Run cannot be opened", () => {
  rpc.summaryResult = {
    _tag: "Failure",
    cause: Cause.fail(new Error("gone")),
    waiting: false,
  };
  render(
    <TestRegistry>
      <RunViewer runId={"agentrun-missing"} />
    </TestRegistry>
  );
  expect(screen.getByText("This Run could not be opened")).toBeVisible();
});

const taskSummary = {
  ...summary,
  assessment: {
    evidence: [{ id: "snapshot-task", kind: "snapshot" }],
    explanation: "The cart remains open with an anvil.",
    outcome: "working",
    submittedAt: "2026-09-04T00:01:00.000Z",
  },
  findings: [
    {
      evidence: [{ id: "attempt-delivery", kind: "attempt" }],
      explanation: "Delivery is unavailable for the selected area.",
      id: "finding-delivery",
      outcome: "not-working",
      submittedAt: "2026-09-04T00:01:00.000Z",
    },
  ],
  inputs: [],
  instructions: [
    {
      instruction: "Leave the cart open instead.",
      receivedAt: "2026-09-04T00:01:00.000Z",
    },
  ],
  outcome: "completed",
  purpose: { kind: "interactive" },
  referencedSkills: [
    {
      flowSkillName: "browse-catalogue",
      referencedAt: "2026-09-04T00:00:00.000Z",
    },
  ],
  requestedTask: "Add an anvil, then inspect delivery.",
  schemaVersion: 3,
  startingEmulation: {
    permissions: [],
    userAgentProfile: "default",
    viewport: { deviceScaleFactor: 1, height: 720, width: 1024 },
  },
};

test("shows a completed task separately from its assessment and evidence-backed findings", () => {
  render(<RunSummaryView summary={taskSummary} />);
  expect(screen.getByText("Execution outcome")).toBeVisible();
  expect(screen.getByText("completed")).toBeVisible();
  expect(screen.getByText(taskSummary.requestedTask)).toBeVisible();
  expect(screen.getByText("Leave the cart open instead.")).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Referenced skills" })
  ).toHaveTextContent("browse-catalogue");
  expect(
    screen.getByRole("region", { name: "Task assessment" })
  ).toHaveTextContent("snapshot-task");
  expect(screen.getByRole("region", { name: "Findings" })).toHaveTextContent(
    "attempt-delivery"
  );
  expect(screen.queryByRole("list", { name: "Agent Steps" })).toBeNull();
  expect(screen.queryByText("Coverage")).toBeNull();
});

test("shows closure without inventing a task assessment", () => {
  render(
    <RunSummaryView
      summary={{ ...taskSummary, assessment: null, outcome: "user-closed" }}
    />
  );
  expect(screen.getByText("user-closed")).toBeVisible();
  expect(screen.getByText("No Agent Assessment submitted.")).toBeVisible();
});

const dryRunTask = {
  ...taskSummary,
  purpose: {
    flowSkillName: "browse-catalogue",
    kind: "dry-run",
    recordingId: "recording-one",
    takeoverOccurred: false,
  },
} as const;

const checkRow = (label: string) =>
  within(screen.getByRole("list", { name: "Pass checks" }))
    .getByText(label)
    .closest("li");

test("leads a passing task Dry Run with its video, verdict, and pass checks", () => {
  render(
    <DryRunSummaryView
      summary={{
        ...dryRunTask,
        assessment: { ...dryRunTask.assessment, outcomeComplete: true },
      }}
    />
  );
  expect(screen.getByLabelText("Recorded Run video")).toHaveAttribute(
    "src",
    "/agent-runs/agentrun-one/video"
  );
  expect(screen.getByText("Dry Run passed")).toBeVisible();
  for (const label of [
    "Run finished",
    "Agent assessment",
    "Full outcome attempted",
    "No takeover",
  ]) {
    expect(
      within(checkRow(label) ?? document.body).getByLabelText("Passed")
    ).toBeVisible();
  }
  expect(
    screen.getByText("The cart remains open with an anvil.")
  ).toBeVisible();
  expect(
    screen.getByRole("list", { name: "Browser evidence" })
  ).toHaveTextContent("snapshot: snapshot-task");
});

test("names the failed check for an incomplete Dry Run with Takeover", () => {
  render(
    <RunSummaryView
      summary={{
        ...dryRunTask,
        assessment: { ...dryRunTask.assessment, outcomeComplete: false },
        purpose: { ...dryRunTask.purpose, takeoverOccurred: true },
      }}
    />
  );
  expect(screen.getByText("Dry Run failed")).toBeVisible();
  expect(checkRow("Full outcome attempted")).toHaveTextContent("No");
  expect(
    within(checkRow("Full outcome attempted") ?? document.body).getByLabelText(
      "Failed"
    )
  ).toBeVisible();
  expect(checkRow("No takeover")).toHaveTextContent("User took control");
  expect(
    within(checkRow("Run finished") ?? document.body).getByLabelText("Passed")
  ).toBeVisible();
});

test("fails a Dry Run the Runner observed failing even when every check passes", () => {
  render(
    <DryRunSummaryView
      result={{
        completedAt: dryRunTask.endedAt,
        inputs: [],
        observableOutcome: "The cart was empty after reload.",
        outcome: "failed",
      }}
      summary={{
        ...dryRunTask,
        assessment: { ...dryRunTask.assessment, outcomeComplete: true },
      }}
    />
  );
  expect(screen.getByText("Dry Run failed")).toBeVisible();
  expect(screen.getByText("The cart was empty after reload.")).toBeVisible();
});

test("keeps findings and the task behind their tabs", async () => {
  const user = userEvent.setup();
  render(
    <DryRunSummaryView
      summary={{
        ...dryRunTask,
        assessment: null,
        outcome: "user-closed",
        videoPath: null,
      }}
    />
  );
  expect(screen.getByText("Dry Run failed")).toBeVisible();
  expect(screen.getByText("This Run recorded no video.")).toBeVisible();
  expect(screen.getByText("No Agent Assessment submitted.")).toBeVisible();
  expect(checkRow("Run finished")).toHaveTextContent("Closed by user");
  expect(screen.queryByRole("list", { name: "Findings" })).toBeNull();

  await user.click(screen.getByRole("tab", { name: /Findings/u }));
  expect(screen.getByRole("list", { name: "Findings" })).toHaveTextContent(
    "Delivery is unavailable for the selected area."
  );
  expect(screen.getByRole("list", { name: "Findings" })).toHaveTextContent(
    "attempt: attempt-delivery"
  );

  await user.click(screen.getByRole("tab", { name: "Task" }));
  expect(screen.getByText(dryRunTask.requestedTask)).toBeVisible();
  expect(
    screen.getByRole("list", { name: "Changed instructions" })
  ).toHaveTextContent("Leave the cart open instead.");
});

const dryRunCapture = {
  _tag: "dry-run-passed",
  draftedAt: summary.startedAt,
  dryRunEndedAt: summary.endedAt,
  dryRunResult: {
    completedAt: summary.endedAt,
    inputs: [],
    observableOutcome: "The cart remains open.",
    outcome: "passed",
  },
  dryRunSessionId: summary.sessionId,
  dryRunStartedAt: summary.startedAt,
  dryRunSummary: {
    ...taskSummary,
    assessment: { ...taskSummary.assessment, outcomeComplete: true },
    purpose: {
      flowSkillName: "browse-catalogue",
      kind: "dry-run",
      recordingId: "recording-one",
      takeoverOccurred: false,
    },
  },
  readyAt: summary.startedAt,
  skillPath: "browse-catalogue/SKILL.md",
  startedAt: summary.startedAt,
  stoppedAt: summary.endedAt,
};

test("offers user verification only for a completed working Dry Run with a complete report and no Takeover", () => {
  expect(teachingRecordingPresentation(dryRunCapture).action?.gesture).toBe(
    "verify-flow"
  );
  for (const invalidSummary of [
    { ...dryRunCapture.dryRunSummary, outcome: "user-closed" },
    { ...dryRunCapture.dryRunSummary, assessment: null },
    {
      ...dryRunCapture.dryRunSummary,
      assessment: {
        ...dryRunCapture.dryRunSummary.assessment,
        outcomeComplete: false,
      },
    },
    {
      ...dryRunCapture.dryRunSummary,
      assessment: {
        ...dryRunCapture.dryRunSummary.assessment,
        outcome: "not-working",
      },
    },
    {
      ...dryRunCapture.dryRunSummary,
      purpose: {
        ...dryRunCapture.dryRunSummary.purpose,
        takeoverOccurred: true,
      },
    },
  ]) {
    const presentation = teachingRecordingPresentation({
      ...dryRunCapture,
      dryRunSummary: invalidSummary,
    });
    expect(presentation.action).toBeNull();
    expect(presentation.tone).toBe("failed");
  }
});
