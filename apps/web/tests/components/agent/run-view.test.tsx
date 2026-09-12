import { RegistryProvider } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Cause, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  RunDetails,
  RunSummaryPanel,
  RunViewer,
} from "@/components/agent/run-view";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { routeTree } from "@/routeTree.gen";

const rpc = vi.hoisted(() => ({
  ceilingCalls: [] satisfies unknown[],
  summaryResult: { _tag: "Initial", waiting: true } satisfies unknown,
}));

const rpcOverrides = {
  agentRunCeilingExtendMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.ceilingCalls.push(payload);
      return {};
    })
  ),
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
  endedAt: null,
  execution: "pending",
  index: 0,
  name: "Open the catalogue",
  startedAt: null,
};

const run = {
  activeStepIndex: 1,
  agentFlowId: "flow-shop",
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
  outcome: null,
  revisionId: "rev-one",
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

const session = {
  activity: "run",
  clientName: "run-agent",
  clientVersion: "2.0.0",
  controller: "agent",
  createdAt: "2026-09-04T00:00:00.000Z",
  currentUrl: "https://shop.example.com/",
  id: "agent-one",
  interruptedAction: null,
  ownerProcessId: "mcp-test",
  phase: "running",
  run,
  takeover: null,
  teaching: null,
  timeline: [],
  updatedAt: "2026-09-04T00:00:00.000Z",
  verification: null,
  viewUrl: "http://127.0.0.1:7777/?session=agent-one",
};

const summary = {
  agentFlowId: "flow-shop",
  assessmentCounts: { blocked: 0, inconclusive: 0, notWorking: 1, working: 1 },
  attribution: run.attribution,
  ceilings: run.ceilings,
  coverage: run.coverage,
  endedAt: "2026-09-04T00:02:00.000Z",
  outcome: "ended-early",
  revisionId: "rev-one",
  runId: "agentrun-one",
  schemaVersion: 1,
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
const asSession = session;

afterEach(() => {
  cleanup();
  rpc.ceilingCalls = [];
  rpc.summaryResult = { _tag: "Initial", waiting: true };
});

test("shows the ordered Agent Steps and which one is active", () => {
  render(
    <TestRegistry>
      <RunDetails session={asSession} />
    </TestRegistry>
  );
  const steps = screen.getByRole("list", { name: "Agent Steps" });
  expect(steps).toBeVisible();
  expect(screen.getByText("1. Open the catalogue")).toBeVisible();
  expect(screen.getByText("Active Agent Step")).toBeVisible();
  expect(
    screen.getByText("The catalogue listed the expected products.")
  ).toBeVisible();
  expect(screen.getByText("Not executed")).toBeVisible();
});

test("reports assessment counts separately from coverage", () => {
  render(
    <TestRegistry>
      <RunDetails session={asSession} />
    </TestRegistry>
  );
  expect(
    screen.getByText("Incomplete · 2 of 3 Agent Steps executed")
  ).toBeVisible();
  expect(
    screen.getByText("1 working · 1 not working · 0 inconclusive · 0 blocked")
  ).toBeVisible();
});

test("marks client-reported model metadata as unverified", () => {
  render(
    <TestRegistry>
      <RunDetails session={asSession} />
    </TestRegistry>
  );
  expect(screen.getByText("Reported model (unverified)")).toBeVisible();
  expect(screen.getByText("run-agent 2.0.0")).toBeVisible();
});

test("extends a ceiling only through a direct user action", async () => {
  const user = userEvent.setup();
  render(
    <TestRegistry>
      <RunDetails session={asSession} />
    </TestRegistry>
  );
  await user.click(
    screen.getByRole("button", { name: "Extend Agent Step ceiling" })
  );
  expect(rpc.ceilingCalls).toHaveLength(1);
  expect(rpc.ceilingCalls[0]).toMatchObject({
    payload: {
      data: { additionalMs: 120_000, scope: "step", sessionId: "agent-one" },
      type: "agent.run.ceiling.extend",
    },
  });
});

test("cannot extend a ceiling once the Run has ended", () => {
  render(
    <TestRegistry>
      <RunDetails
        session={
          {
            ...session,
            run: { ...run, outcome: "timed-out" },
          } satisfies unknown
        }
      />
    </TestRegistry>
  );
  expect(
    screen.getByRole("button", { name: "Extend Run ceiling" })
  ).toBeDisabled();
  expect(screen.getByText("A ceiling was reached")).toBeVisible();
});

test("shows no Run Summary while the Run is still live", () => {
  rpc.summaryResult = successfulSummary;
  render(
    <TestRegistry>
      <RunSummaryPanel session={asSession} />
    </TestRegistry>
  );
  expect(screen.queryByText("Run Summary")).toBeNull();
});

test("embeds the local Run video in the summary of a finished Run", () => {
  rpc.summaryResult = successfulSummary;
  render(
    <TestRegistry>
      <RunSummaryPanel
        session={
          {
            ...session,
            run: { ...run, outcome: "ended-early" },
          } satisfies unknown
        }
      />
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
