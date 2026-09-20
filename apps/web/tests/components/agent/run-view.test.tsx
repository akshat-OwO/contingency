import { RegistryProvider } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { Cause } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { RunSummaryView, RunViewer } from "@/components/agent/run-view";
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
  ceilings: { extensions: 0, runMs: 900_000, stepMs: 120_000 },
  coverage: { complete: false, executed: 2, total: 3, unexecuted: 1 },
  endedAt: null,
  flowSkillName: "browse-catalogue",
  inputs: [{ name: "product", value: "Mug" }],
  outcome: null,
  runDeadline: "2026-09-04T00:15:00.000Z",
  runId: "agentrun-one",
  startedAt: "2026-09-04T00:00:00.000Z",
  stepDeadline: "2026-09-04T00:02:00.000Z",
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
  ceilings: run.ceilings,
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
