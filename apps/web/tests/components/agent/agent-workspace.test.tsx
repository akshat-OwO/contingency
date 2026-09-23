import { RegistryProvider } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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
import { afterEach, expect, test, vi } from "vitest";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { routeTree } from "@/routeTree.gen";

const rpc = vi.hoisted(() => ({
  agentStreamFailureMessage: undefined,
  ceilingCalls: [] satisfies unknown[],
  discardCalls: [] satisfies unknown[],
  inputCalls: [] satisfies unknown[],
  inspectedElement: {
    description: "button: Place order",
    height: 40,
    ref: "e12",
    width: 120,
    x: 20,
    y: 60,
  } satisfies unknown,
  instructionCalls: [] satisfies unknown[],
  navigateCalls: [] satisfies unknown[],
  renameCalls: [] satisfies unknown[],
  returnControlCalls: [] satisfies unknown[],
  sessionsResult: {
    _tag: "Initial",
    waiting: true,
  } satisfies unknown,
  startRecordingCalls: [] satisfies unknown[],
  startSessionCalls: [] satisfies unknown[],
  startedSession: {} satisfies unknown,
  stopRecordingCalls: [] satisfies unknown[],
  takeoverCalls: [] satisfies unknown[],
  verifyFailure: undefined satisfies unknown,
}));

/** The draft review is not what this test reads, so its revision never lands. */

const rpcOverrides = {
  agentBrowserElementInspectMutation: Atom.fn(() =>
    Effect.sync(() => ({ data: { element: rpc.inspectedElement } }))
  ),
  agentBrowserFrameAckMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserInputMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.inputCalls.push(payload);
      return {};
    })
  ),
  agentBrowserNavigateMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.navigateCalls.push(payload);
      return {};
    })
  ),
  agentReturnControlMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.returnControlCalls.push(payload);
      return {};
    })
  ),
  agentRunCeilingExtendMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.ceilingCalls.push(payload);
      return {};
    })
  ),
  agentSessionStartMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.startSessionCalls.push(payload);
      return { data: { session: rpc.startedSession } };
    })
  ),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
  agentTakeoverMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.takeoverCalls.push(payload);
      return {};
    })
  ),
  agentTeachingFlowRenameMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.renameCalls.push(payload);
      return {};
    })
  ),
  agentTeachingFlowVerifyMutation: Atom.fn(() =>
    Effect.fail(rpc.verifyFailure)
  ),
  agentTeachingInstructionRecordMutation: Atom.fn(
    <Payload,>(payload: Payload) =>
      Effect.sync(() => {
        rpc.instructionCalls.push(payload);
        return {};
      })
  ),
  agentTeachingRecordingDiscardMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.discardCalls.push(payload);
      return {};
    })
  ),
  agentTeachingRecordingStartMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.startRecordingCalls.push(payload);
      return {};
    })
  ),
  agentTeachingRecordingStopMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.stopRecordingCalls.push(payload);
      return {};
    })
  ),
  runAgentBrowserStream: () => Effect.never,
  runAgentSessionStream: () =>
    rpc.agentStreamFailureMessage === undefined
      ? Effect.never
      : Effect.fail(new Error(rpc.agentStreamFailureMessage)),
};

const TestRegistry = ({ children }: { readonly children: ReactNode }) => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <RegistryProvider>{children}</RegistryProvider>
  </RpcDependenciesProvider>
);

const session = {
  activity: "run",
  clientName: "Test agent",
  clientVersion: "1.0",
  controller: "agent",
  createdAt: "2026-08-31T00:00:00.000Z",
  currentUrl: "https://example.com/",
  id: "agent-one",
  interruptedAction: null,
  ownerProcessId: "mcp-test",
  phase: "running",
  run: null,
  takeover: null,
  teaching: null,
  timeline: [],
  updatedAt: "2026-08-31T00:00:00.000Z",
  verification: null,
  viewUrl: "http://127.0.0.1:7777/?session=agent-one",
};

/** One live Interactive Run, on its second Agent Step. */
const runningSession = {
  ...session,
  dryRun: null,
  run: {
    activeStepIndex: 1,
    assessmentCounts: {
      blocked: 0,
      inconclusive: 0,
      notWorking: 0,
      working: 1,
    },
    attribution: {
      clientName: "Test agent",
      clientVersion: "1.0",
      reportedMetadataVerified: false,
      reportedModel: null,
      reportedProvider: null,
    },
    ceilings: { extensions: 0, runMs: 900_000, stepMs: 120_000 },
    coverage: { complete: false, executed: 1, total: 2, unexecuted: 1 },
    endedAt: null,
    flowSkillName: "browse-catalogue",
    inputs: [],
    outcome: null,
    runDeadline: "2026-08-31T00:15:00.000Z",
    runId: "agentrun-one",
    startedAt: "2026-08-31T00:00:00.000Z",
    stepDeadline: "2026-08-31T00:02:00.000Z",
    steps: [
      {
        assessment: {
          attempts: 1,
          evidence: [{ id: "snapshot-1", kind: "snapshot" }],
          explanation: "The catalogue listed the expected products.",
          outcome: "working",
          submittedAt: "2026-08-31T00:00:30.000Z",
        },
        attempts: 1,
        confirmation: false,
        description: "Open the catalogue.",
        doneWhen: "the catalogue lists at least one product.",
        endedAt: "2026-08-31T00:00:30.000Z",
        execution: "assessed",
        index: 0,
        name: "Open the catalogue",
        startedAt: "2026-08-31T00:00:01.000Z",
      },
      {
        assessment: null,
        attempts: 0,
        confirmation: false,
        description: "Add the product to the basket.",
        doneWhen: "the basket holds one product.",
        endedAt: null,
        execution: "active",
        index: 1,
        name: "Add to basket",
        startedAt: "2026-08-31T00:00:31.000Z",
      },
    ],
    title: "Buy one product",
    variables: [],
  },
} satisfies unknown;

/** One live Dry Run, rehearsing a drafted Flow Skill with a changed input. */
const dryRunSession = {
  ...session,
  clientName: "flow-skill-dry-run",
  dryRun: {
    flowSkillName: "add-anvil",
    inputs: [
      { changed: true, name: "product", value: "Anvil" },
      { changed: false, name: "quantity", value: "1" },
    ],
    recordingId: "recording-add-anvil",
    startedAt: "2026-08-31T00:00:06.000Z",
  },
  run: null,
} satisfies unknown;

type Session = typeof session;

rpc.startedSession = { ...session, id: "agent-started" };

const resultFor = (sessions: readonly Session[]) => ({
  _tag: "Success",
  value: {
    data: { sessions },
    type: "agent.sessions.result",
  },
  waiting: false,
});

type SessionsResult =
  | ReturnType<typeof resultFor>
  | { readonly _tag: "Failure"; readonly error: Error; readonly waiting: false }
  | { readonly _tag: "Initial"; readonly waiting: true };

const renderWorkspace = (result: SessionsResult, requestedSessionId?: string) =>
  (() => {
    rpc.sessionsResult = result;
    return render(
      <TestRegistry>
        <AgentWorkspace requestedSessionId={requestedSessionId} />
      </TestRegistry>
    );
  })();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rpc.agentStreamFailureMessage = undefined;
  rpc.ceilingCalls = [];
  rpc.discardCalls = [];
  rpc.inputCalls = [];
  rpc.instructionCalls = [];
  rpc.renameCalls = [];
  rpc.startSessionCalls = [];
  rpc.navigateCalls = [];
  rpc.returnControlCalls = [];
  rpc.startRecordingCalls = [];
  rpc.stopRecordingCalls = [];
  rpc.takeoverCalls = [];
  rpc.verifyFailure = undefined;
});

test("announces that Agent Sessions are loading", () => {
  renderWorkspace({ _tag: "Initial", waiting: true });
  expect(screen.getByText("Loading Agent Sessions…")).toBeVisible();
});

test("invites the user to open a session from the empty canvas", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([]));
  expect(await screen.findByText("No browser session")).toBeVisible();
  // The canvas owns the invitation, so the dock shows the state without
  // repeating the action under the same name.
  expect(
    screen.getAllByRole("button", { name: "Open browser session" })
  ).toHaveLength(1);
  expect(screen.getByText("No session")).toBeVisible();

  await user.click(
    screen.getByRole("button", { name: "Open browser session" })
  );
  await waitFor(() => {
    expect(rpc.startSessionCalls).toHaveLength(1);
  });
  expect(rpc.startSessionCalls[0]).toMatchObject({
    payload: {
      data: { activity: "teaching" },
      type: "agent.session.start",
    },
  });
});

test("explains when Agent Sessions cannot be loaded", async () => {
  renderWorkspace({
    _tag: "Failure",
    error: new Error("offline"),
    waiting: false,
  });
  expect(
    await screen.findByText(
      "Agent Sessions are unavailable in this server process."
    )
  ).toBeVisible();
});

test("opens an owned session and shows the live browser view", async () => {
  renderWorkspace(resultFor([session]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(
    within(dock).getByRole("combobox", { name: "Agent Session" })
  ).toHaveValue(session.id);
  expect(screen.getByLabelText("Live browser viewport")).toBeInTheDocument();
  expect(
    within(dock).getByRole("button", { name: "Take control" })
  ).toBeVisible();
});

test("gives a Run the same dock-only shell as Teaching", async () => {
  renderWorkspace(resultFor([runningSession]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Contingency");
  // The Flow Skill, which Agent Step it is on, and coverage. The step's name
  // and its "Done when:" line are behind the counter, not in the row (#238).
  expect(dock).toHaveTextContent("browse-catalogue");
  expect(dock).toHaveTextContent("Agent Step 2 of 2.");
  expect(dock).not.toHaveTextContent("Done when:");
  expect(dock).toHaveTextContent("1 of 2 Agent Steps executed");
  // One shell: no header band above it, and no session status sidebar beside it.
  expect(screen.queryByRole("heading", { name: "Workspace" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Session status" })).toBeNull();
  expect(screen.queryByRole("list", { name: "Action timeline" })).toBeNull();
  // Exactly one control, and it is in the dock.
  expect(
    within(dock).getByRole("button", { name: "Take control" })
  ).toBeVisible();
  expect(
    screen.getAllByRole("button", { name: /^(?:Take|Return) control$/u })
  ).toHaveLength(1);
});

test("holds the Agent Step's detail behind the step counter", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([runningSession]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  await user.click(
    within(dock).getByRole("button", {
      name: "1 of 2 Agent Steps executed. Agent Step 2 of 2.",
    })
  );
  expect(await screen.findByText("Agent Step 2 of 2")).toBeVisible();
  expect(screen.getByText("Add to basket")).toBeVisible();
  expect(
    screen.getByText("Done when: the basket holds one product.")
  ).toBeVisible();
});

test("gives a Dry Run the dock, the flow it rehearses, and its changed inputs", async () => {
  renderWorkspace(resultFor([dryRunSession]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Rehearsing the flow skill add-anvil.");
  expect(dock).toHaveTextContent("Changed inputs: product");
  expect(
    within(dock).getByRole("option", { name: "add-anvil · Dry Run" })
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Session status" })).toBeNull();
});

test("labels an Interactive Run without exposing a raw session id", async () => {
  renderWorkspace(resultFor([runningSession]), session.id);
  const option = await screen.findByRole("option", {
    name: "browse-catalogue · Interactive Run",
  });
  expect(option).toBeVisible();
  expect(option).not.toHaveTextContent(session.id);
});

test("extends a ceiling only through a direct user action", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([runningSession]), session.id);
  await user.click(
    await screen.findByRole("button", { name: "Extend Agent Step ceiling" })
  );
  await waitFor(() => {
    expect(rpc.ceilingCalls).toHaveLength(1);
  });
  expect(rpc.ceilingCalls[0]).toMatchObject({
    payload: {
      data: { additionalMs: 120_000, scope: "step", sessionId: session.id },
      type: "agent.run.ceiling.extend",
    },
  });
});

test("offers no ceiling extension once the Run has ended", async () => {
  renderWorkspace(
    resultFor([
      {
        ...runningSession,
        run: {
          ...runningSession.run,
          activeStepIndex: null,
          outcome: "timed-out",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent(
    "A ceiling was reached, so the run timed out."
  );
  expect(
    screen.queryByRole("button", { name: "Extend Run ceiling" })
  ).toBeNull();
});

test("does not use a foreign URL session id, and still offers the dock", async () => {
  renderWorkspace(resultFor([session]), "agent-foreign");
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(
    within(dock).getByRole("combobox", { name: "Agent Session" })
  ).toHaveValue(session.id);
  expect(screen.getByLabelText("Live browser viewport")).toBeInTheDocument();
  expect(screen.queryByText(/not owned by this server process/u)).toBeNull();
});

test("keeps the empty dock when a foreign id is the only thing asked for", async () => {
  renderWorkspace(resultFor([]), "agent-foreign");
  expect(
    await screen.findByText(/not owned by this server process/u)
  ).toBeVisible();
  expect(screen.getByText("No browser session")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Open browser session" })
  ).toBeVisible();
});

test("shows the Agent Session stream failure reason", async () => {
  rpc.agentStreamFailureMessage = "The Agent Session stream disconnected.";
  renderWorkspace(resultFor([session]), session.id);

  expect(
    await screen.findByText("The Agent Session stream disconnected.")
  ).toBeVisible();
});

test("marks a selected session as switching before its stream resumes", async () => {
  const secondSession = { ...session, id: "agent-two" };
  renderWorkspace(resultFor([session, secondSession]), session.id);
  const select = await screen.findByRole("combobox", { name: "Agent Session" });
  await userEvent.selectOptions(select, secondSession.id);
  await waitFor(() => {
    expect(screen.getByText("Switching Agent Session…")).toBeVisible();
  });
});

test("keeps a selected Agent Session in the route query", async () => {
  const secondSession = {
    ...session,
    currentUrl: "https://www.1mg.com/",
    id: "agent-two",
    viewUrl: "http://127.0.0.1:7777/?session=agent-two",
  };
  rpc.sessionsResult = resultFor([session, secondSession]);
  const history = createMemoryHistory({
    initialEntries: [`/?session=${session.id}`],
  });
  const testRouter = createRouter({ history, routeTree });
  await testRouter.load();
  render(
    <TestRegistry>
      <RouterProvider router={testRouter} />
    </TestRegistry>
  );

  const select = await screen.findByRole("combobox", {
    name: "Agent Session",
  });
  await userEvent.selectOptions(select, secondSession.id);

  await waitFor(() => {
    expect(testRouter.state.location.search).toEqual({
      session: secondSession.id,
    });
    expect(select).toHaveValue(secondSession.id);
  });
});

test("replaces a missing session id with the session shown in Workspace", async () => {
  rpc.sessionsResult = resultFor([session]);
  const history = createMemoryHistory({
    initialEntries: ["/?session=agent-foreign"],
  });
  const testRouter = createRouter({ history, routeTree });
  await testRouter.load();
  render(
    <TestRegistry>
      <RouterProvider router={testRouter} />
    </TestRegistry>
  );

  const select = await screen.findByRole("combobox", {
    name: "Agent Session",
  });
  await waitFor(() => {
    expect(select).toHaveValue(session.id);
    expect(testRouter.state.location.search).toEqual({ session: session.id });
    expect(screen.queryByText(/not owned by this server process/u)).toBeNull();
  });
});

test("names who holds the browser in the dock", async () => {
  renderWorkspace(resultFor([session]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("The agent has control.");
});

test("names the drafted Flow Skill in the Teaching dock", async () => {
  renderWorkspace(
    resultFor([
      {
        ...session,
        activity: "teaching",
        captureState: {
          _tag: "skill-drafted",
          draftedAt: "2026-08-31T00:00:05.000Z",
          readyAt: "2026-08-31T00:00:04.000Z",
          skillPath: "browse-catalogue/SKILL.md",
          startedAt: "2026-08-31T00:00:01.000Z",
          stoppedAt: "2026-08-31T00:00:03.000Z",
        },
        flowSkillName: "browse-catalogue",
        recordingId: "recording-browse-catalogue",
        teaching: { actionCount: 4, instructionCount: 2, instructions: [] },
      } satisfies unknown,
    ]),
    session.id
  );
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Flow skill drafted");
  expect(
    within(dock).getByRole("option", {
      name: "browse-catalogue",
    })
  ).toBeVisible();
});

test("takes control from Workspace and returns it explicitly", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([session]), session.id);
  await user.click(await screen.findByRole("button", { name: "Take control" }));
  await waitFor(() => {
    expect(rpc.takeoverCalls).toHaveLength(1);
  });

  cleanup();
  renderWorkspace(
    resultFor([
      {
        ...session,
        controller: "user",
        interruptedAction: {
          actor: "agent",
          at: "2026-08-31T00:00:03.000Z",
          description: "Click e4",
          detail:
            "Takeover interrupted this action. The browser may already have performed it.",
          dispatched: true,
          id: "action-three",
          outcome: "interrupted",
        },
        phase: "takeover",
        takeover: {
          reason: "I will finish this myself.",
          requestedAt: "2026-08-31T00:00:03.000Z",
          requestedBy: "user",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("You have control.");
  expect(screen.getByText(/may already have performed it/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Return control" }));
  await waitFor(() => {
    expect(rpc.returnControlCalls).toHaveLength(1);
  });
});

test("offers no control exchange during a user-led Demonstration", async () => {
  renderWorkspace(
    resultFor([
      {
        ...session,
        activity: "teaching",
        captureState: {
          _tag: "recording",
          startedAt: "2026-08-31T00:00:01.000Z",
        },
        controller: "user",
        flowSkillName: "browse-catalogue",
        recordingId: "recording-browse-catalogue",
        teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
      } satisfies unknown,
    ]),
    session.id
  );
  await screen.findByRole("region", { name: "Workspace dock" });
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Return control" })).toBeNull();
});

test("starts and stops Teaching recording from the privacy dock", async () => {
  const user = userEvent.setup();
  const setup = {
    ...session,
    activity: "teaching",
    captureState: {
      _tag: "setup",
      requestedAt: "2026-08-31T00:00:00.000Z",
    },
    controller: "user",
    flowSkillName: "browse-catalogue",
    recordingId: "recording-browse-catalogue",
    teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
  } satisfies unknown;
  renderWorkspace(resultFor([setup]), session.id);
  expect(await screen.findByText("Not recording")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Start recording" }));
  await waitFor(() => {
    expect(rpc.startRecordingCalls).toHaveLength(1);
  });
  expect(rpc.startRecordingCalls[0]).toMatchObject({
    payload: {
      data: { sessionId: session.id },
      type: "agent.teaching.recording.start",
    },
  });

  cleanup();
  renderWorkspace(
    resultFor([
      {
        ...setup,
        captureState: {
          _tag: "recording",
          startedAt: "2026-08-31T00:00:01.000Z",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  await user.click(
    await screen.findByRole("button", { name: "Stop recording" })
  );
  await waitFor(() => {
    expect(rpc.stopRecordingCalls).toHaveLength(1);
  });
  expect(rpc.stopRecordingCalls[0]).toMatchObject({
    payload: {
      data: { sessionId: session.id },
      type: "agent.teaching.recording.stop",
    },
  });
});

test("forwards browser input only while the user holds the browser", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([session]), session.id);
  const watching = await screen.findByLabelText("Live browser viewport");
  expect(watching).toHaveAttribute("aria-readonly", "true");
  await user.click(watching);
  expect(rpc.inputCalls).toHaveLength(0);

  cleanup();
  renderWorkspace(
    resultFor([
      {
        ...session,
        controller: "user",
        phase: "takeover",
        takeover: {
          reason: "I will finish this myself.",
          requestedAt: "2026-08-31T00:00:03.000Z",
          requestedBy: "user",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  const driving = await screen.findByLabelText("Live browser viewport");
  expect(driving).toHaveAttribute("aria-readonly", "false");
  await user.click(driving);
  await waitFor(() => {
    expect(rpc.inputCalls.length).toBeGreaterThan(0);
  });
});

const takenOverSession = {
  ...session,
  controller: "user",
  currentUrl: "https://example.com/dashboard",
  phase: "takeover",
  takeover: {
    reason: "I will finish this myself.",
    requestedAt: "2026-08-31T00:00:03.000Z",
    requestedBy: "user",
  },
} satisfies unknown;

test("keeps Teaching private Variable entry out of Workspace", async () => {
  renderWorkspace(
    resultFor([
      {
        ...takenOverSession,
        activity: "teaching",
        captureState: {
          _tag: "recording",
          startedAt: "2026-08-31T00:00:01.000Z",
        },
        flowSkillName: "private-variable-flow",
        recordingId: "recording-private-variable-flow",
        teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
      } satisfies unknown,
    ]),
    session.id
  );
  await screen.findByRole("region", { name: "Workspace dock" });
  expect(
    screen.queryByRole("button", { name: "Enter private value" })
  ).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Enter a private Variable" })
  ).toBeNull();
});

test("offers browser navigation only while the user holds the browser", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([session]), session.id);
  expect(await screen.findByLabelText("Go back")).toBeDisabled();
  expect(screen.getByLabelText("Reload page")).toBeDisabled();
  expect(screen.getByLabelText("Browser address")).toBeDisabled();

  cleanup();
  renderWorkspace(resultFor([takenOverSession]), session.id);
  const back = await screen.findByLabelText("Go back");
  expect(back).toBeEnabled();
  await user.click(back);
  await waitFor(() => {
    expect(rpc.navigateCalls).toHaveLength(1);
  });
  expect(rpc.navigateCalls.at(0)).toMatchObject({
    payload: {
      data: {
        action: { action: "back", type: "history" },
        sessionId: session.id,
      },
      type: "agent.browser.navigate",
    },
  });
});

test("navigates to a typed address during Takeover", async () => {
  const user = userEvent.setup();
  rpc.navigateCalls.length = 0;
  renderWorkspace(resultFor([takenOverSession]), session.id);
  const address = await screen.findByLabelText("Browser address");
  expect(address).toHaveValue("https://example.com/dashboard");
  await user.clear(address);
  await user.type(address, "example.org/pricing{Enter}");
  await waitFor(() => {
    expect(rpc.navigateCalls).toHaveLength(1);
  });
  expect(rpc.navigateCalls.at(0)).toMatchObject({
    payload: {
      data: {
        action: { type: "navigate", url: "https://example.org/pricing" },
      },
    },
  });
});

test("scrolls the browser with the wheel only during Takeover", async () => {
  renderWorkspace(resultFor([session]), session.id);
  const watching = await screen.findByLabelText("Live browser viewport");
  rpc.inputCalls.length = 0;
  watching.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 })
  );
  expect(rpc.inputCalls).toHaveLength(0);

  cleanup();
  renderWorkspace(resultFor([takenOverSession]), session.id);
  const driving = await screen.findByLabelText("Live browser viewport");
  driving.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 })
  );
  await waitFor(() => {
    expect(rpc.inputCalls).toHaveLength(1);
  });
  expect(rpc.inputCalls.at(0)).toMatchObject({
    payload: {
      data: {
        input: { deltaY: 240, eventType: "mouseWheel", type: "input_mouse" },
      },
    },
  });
});

const teachingSetup = {
  ...session,
  activity: "teaching",
  captureState: { _tag: "setup", requestedAt: "2026-08-31T00:00:00.000Z" },
  controller: "user",
  flowSkillName: "browse-catalogue",
  recordingId: "recording-browse-catalogue",
  teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
} satisfies unknown;

const teachingRecording = {
  ...teachingSetup,
  captureState: { _tag: "recording", startedAt: "2026-08-31T00:00:01.000Z" },
} satisfies unknown;

test("composes the Teaching dock with distinct accessible names", async () => {
  renderWorkspace(resultFor([teachingRecording]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Contingency");
  expect(dock).toHaveTextContent("Recording");
  // A Teaching option is the Flow Skill name; the state lives in the badge.
  expect(
    within(dock).getByRole("option", { name: "browse-catalogue" })
  ).toBeVisible();
  expect(
    within(dock).getByRole("button", { name: "Stop recording" })
  ).toBeVisible();
  expect(
    within(dock).getByRole("button", { name: "Inspect an element and comment" })
  ).toBeVisible();
  expect(
    within(dock).queryByRole("button", { name: "Start recording" })
  ).toBeNull();
  // Later-state actions have no RPC yet, so they are absent, not disabled.
  expect(screen.queryByRole("button", { name: "Learn flow" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dry run" })).toBeNull();
});

test("keeps every dock control reachable from the keyboard", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  const controls = [
    within(dock).getByRole("combobox", { name: "Agent Session" }),
    within(dock).getByRole("button", {
      name: "Inspect an element and comment",
    }),
    within(dock).getByRole("button", { name: "Stop recording" }),
  ];
  for (const control of controls) {
    control.focus();
    expect(control).toHaveFocus();
  }
  await user.tab();
  expect(dock).not.toHaveFocus();
});

test("attaches an inspect comment as a Teaching instruction", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(
    await screen.findByRole("button", {
      name: "Inspect an element and comment",
    })
  );
  const canvas = screen.getByLabelText("Live browser viewport");
  const overlay = canvas.nextElementSibling;
  expect(overlay).not.toBeNull();
  // SAFETY: the assertion above proves the overlay element exists.
  await user.click(overlay as Element);
  // The frozen element is filled, not only outlined, so the user can see which
  // element the comment attaches to (#212).
  // SAFETY: the click froze an element, so the overlay drew its highlight.
  const highlight = (overlay as Element).firstElementChild as Element;
  expect(highlight.className).toContain("bg-blue-500/20");
  expect(highlight.className).toContain("border-blue-500");
  const field = await screen.findByLabelText("Describe the change");
  await user.type(field, "Use the express checkout here.");
  await user.click(screen.getByRole("button", { name: "Attach" }));

  await waitFor(() => {
    expect(rpc.instructionCalls).toHaveLength(1);
  });
  expect(rpc.instructionCalls[0]).toMatchObject({
    payload: {
      data: {
        sessionId: session.id,
        target: "button: Place order",
        text: "Use the express checkout here.",
      },
      type: "agent.teaching.instruction.record",
    },
  });
  // The dock adds no second instruction field beside inspect's own.
  expect(screen.queryByLabelText("Add instruction")).toBeNull();
});

test("reads the attached comments back from the dock's count", async () => {
  const user = userEvent.setup();
  renderWorkspace(
    resultFor([
      {
        ...teachingRecording,
        teaching: {
          actionCount: 3,
          instructionCount: 2,
          instructions: [
            {
              at: "2026-08-31T00:00:02.000Z",
              id: "instruction-1",
              target: "button: Place order",
              text: "Use the express checkout here.",
            },
            {
              /* Relayed over MCP: no element, so no target to name. */
              at: "2026-08-31T00:00:03.000Z",
              id: "instruction-2",
              target: null,
              text: "Stop once the receipt shows.",
            },
          ],
        },
      } satisfies unknown,
    ]),
    session.id
  );
  const count = await screen.findByRole("button", { name: "2 comments" });
  await user.click(count);
  const list = await screen.findByRole("list");
  const items = within(list).getAllByRole("listitem");
  // Newest first: the instruction just attached is the one being checked.
  expect(items[0]).toHaveTextContent("Stop once the receipt shows.");
  expect(items[1]).toHaveTextContent("Use the express checkout here.");
  expect(items[1]).toHaveTextContent("button: Place order");

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("list")).toBeNull();
  });
});

test("leaves the dock's comment count out when nothing is attached", async () => {
  renderWorkspace(resultFor([teachingRecording]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(
    within(dock).queryByRole("button", { name: /^\d+ comments?$/u })
  ).toBeNull();
  expect(
    within(dock).getByRole("button", { name: "Inspect an element and comment" })
  ).toBeVisible();
});

test("offers Rename flow in setup and deletion once a recording is saved", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingSetup]), session.id);
  await user.click(await screen.findByRole("button", { name: "Rename flow" }));
  const name = screen.getByLabelText("Flow skill name");
  await user.clear(name);
  await user.type(name, "place-order");
  await user.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() => {
    expect(rpc.renameCalls).toHaveLength(1);
  });
  expect(rpc.renameCalls[0]).toMatchObject({
    payload: {
      data: { name: "place-order", sessionId: session.id },
      type: "agent.teaching.flow.rename",
    },
  });

  cleanup();
  renderWorkspace(
    resultFor([
      {
        ...teachingSetup,
        captureState: {
          _tag: "ready",
          readyAt: "2026-08-31T00:00:04.000Z",
          startedAt: "2026-08-31T00:00:01.000Z",
          stoppedAt: "2026-08-31T00:00:03.000Z",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  // `ready` still offers Start recording for a second bundle in the same setup.
  expect(
    await screen.findByRole("button", { name: "Start recording" })
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Copy agent prompt" })
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Delete recording" }));
  await waitFor(() => {
    expect(rpc.discardCalls).toHaveLength(1);
  });
  expect(rpc.discardCalls[0]).toMatchObject({
    payload: {
      data: { sessionId: session.id },
      type: "agent.teaching.recording.discard",
    },
  });
});

test("leaves inspect and its pins with the recording they belong to", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(
    await screen.findByRole("button", {
      name: "Inspect an element and comment",
    })
  );
  const canvas = screen.getByLabelText("Live browser viewport");
  // SAFETY: inspect mode is open, so the overlay is the canvas's next sibling.
  await user.click(canvas.nextElementSibling as Element);
  await user.type(
    await screen.findByLabelText("Describe the change"),
    "Use the express checkout here."
  );
  await user.click(screen.getByRole("button", { name: "Attach" }));
  await waitFor(() => {
    expect(rpc.instructionCalls).toHaveLength(1);
  });

  cleanup();
  renderWorkspace(
    resultFor([
      {
        ...teachingSetup,
        captureState: {
          _tag: "ready",
          readyAt: "2026-08-31T00:00:04.000Z",
          startedAt: "2026-08-31T00:00:01.000Z",
          stoppedAt: "2026-08-31T00:00:03.000Z",
        },
      } satisfies unknown,
    ]),
    session.id
  );
  await screen.findByText("Recording saved");
  expect(screen.queryByLabelText("Describe the change")).toBeNull();
});

const teachingReady = {
  ...teachingSetup,
  captureState: {
    _tag: "ready",
    readyAt: "2026-08-31T00:00:04.000Z",
    startedAt: "2026-08-31T00:00:01.000Z",
    stoppedAt: "2026-08-31T00:00:03.000Z",
  },
} satisfies unknown;

const teachingDrafted = {
  ...teachingSetup,
  captureState: {
    _tag: "skill-drafted",
    draftedAt: "2026-08-31T00:00:06.000Z",
    readyAt: "2026-08-31T00:00:04.000Z",
    skillPath: "browse-catalogue/SKILL.md",
    startedAt: "2026-08-31T00:00:01.000Z",
    stoppedAt: "2026-08-31T00:00:03.000Z",
  },
} satisfies unknown;

test("names the dry run hand-off for the clipboard write it performs", async () => {
  const user = userEvent.setup();
  // `userEvent.setup` installs its own clipboard, so the spy goes in after it.
  const writeText = vi
    .spyOn(globalThis.navigator.clipboard, "writeText")
    .mockImplementation(() => Promise.resolve());
  renderWorkspace(resultFor([teachingDrafted]), session.id);

  // A button reading "Dry run" started nothing, which read as a broken
  // build. The dock now says what it does (#210).
  expect(
    await screen.findByRole("button", { name: "Copy dry run prompt" })
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Dry run" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Copy dry run prompt" }));
  await waitFor(() => {
    expect(writeText).toHaveBeenCalledTimes(1);
  });
  expect(writeText.mock.calls[0]?.[0]).toContain(
    "agent_flow_skill_dry_run_start"
  );
});

test("copies the flow skill path rather than claiming to read it", async () => {
  const user = userEvent.setup();
  // `userEvent.setup` installs its own clipboard, so the spy goes in after it.
  const writeText = vi
    .spyOn(globalThis.navigator.clipboard, "writeText")
    .mockImplementation(() => Promise.resolve());
  renderWorkspace(resultFor([teachingDrafted]), session.id);

  expect(screen.queryByRole("button", { name: "Read flow skill" })).toBeNull();
  await user.click(
    await screen.findByRole("button", { name: "Copy flow skill path" })
  );
  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith("browse-catalogue/SKILL.md");
  });
});

test("confirms a copy on the button that performed it, then lets it rest", async () => {
  const user = userEvent.setup();
  // `userEvent.setup` installs its own clipboard, so the spy goes in after it.
  vi.spyOn(globalThis.navigator.clipboard, "writeText").mockImplementation(() =>
    Promise.resolve()
  );
  renderWorkspace(resultFor([teachingDrafted]), session.id);

  await user.click(
    await screen.findByRole("button", { name: "Copy dry run prompt" })
  );
  // The confirmation names what was copied rather than being a colour or a
  // tick alone, and it reaches assistive technology (#214).
  const copied = await screen.findByRole("button", {
    name: "Copied dry run prompt",
  });
  expect(copied).toBeVisible();
  expect(
    screen.getByRole("status", { name: "Copy confirmation" })
  ).toHaveTextContent("Copied dry run prompt");

  // The confirmation clears itself: the resting label comes back without the
  // user doing anything. This waits out the real hold rather than a fake
  // clock, which the Workspace's own render loop does not survive.
  await waitFor(
    () => {
      expect(
        screen.getByRole("button", { name: "Copy dry run prompt" })
      ).toBeVisible();
    },
    { timeout: 4000 }
  );
  expect(
    screen.getByRole("status", { name: "Copy confirmation" })
  ).toHaveTextContent("");
}, 10_000);

test("sizes the clipboard hand-off like the dock's other secondary actions", async () => {
  renderWorkspace(resultFor([teachingReady]), session.id);
  const copy = await screen.findByRole("button", {
    name: "Copy agent prompt",
  });
  const neighbour = screen.getByRole("button", { name: "Delete recording" });
  expect(copy.className).toBe(neighbour.className);
});

test("surfaces a refused clipboard write instead of looking like it worked", async () => {
  const user = userEvent.setup();
  // `userEvent.setup` installs its own clipboard, so the spy goes in after it.
  vi.spyOn(globalThis.navigator.clipboard, "writeText").mockImplementation(() =>
    Promise.reject(new Error("Denied"))
  );
  renderWorkspace(resultFor([teachingDrafted]), session.id);

  await user.click(
    await screen.findByRole("button", { name: "Copy dry run prompt" })
  );
  expect(
    await screen.findByText(
      "The dry run prompt could not be copied to the clipboard."
    )
  ).toBeVisible();
  // A refused write confirms nothing: the button keeps its resting label.
  expect(
    screen.getByRole("button", { name: "Copy dry run prompt" })
  ).toBeVisible();
});

const dryRunPassedSession = {
  ...session,
  activity: "teaching",
  captureState: {
    _tag: "dry-run-passed",
    draftedAt: "2026-08-31T00:00:05.000Z",
    dryRunResult: {
      observableOutcome: "The anvil is in the cart.",
      passed: true,
      reportedAt: "2026-08-31T00:00:08.000Z",
    },
    dryRunStartedAt: "2026-08-31T00:00:06.000Z",
    readyAt: "2026-08-31T00:00:04.000Z",
    skillPath: "add-anvil/SKILL.md",
    startedAt: "2026-08-31T00:00:01.000Z",
    stoppedAt: "2026-08-31T00:00:03.000Z",
  },
  flowSkillName: "add-anvil",
  recordingId: "recording-add-anvil",
  teaching: { actionCount: 4, instructionCount: 0, instructions: [] },
} satisfies unknown;

test("says which lifecycle refused a gesture instead of rendering an object", async () => {
  const user = userEvent.setup();
  // The refusal shape behind #211: an RPC error, not an `Error`.
  rpc.verifyFailure = {
    _tag: "BrowserRpcError",
    code: "agent_session_conflict",
    message:
      "Teaching Recording recording-add-anvil cannot be verified from verified.",
  };
  renderWorkspace(resultFor([dryRunPassedSession]), session.id);

  await user.click(await screen.findByRole("button", { name: "Verify flow" }));

  expect(
    await screen.findByText(
      "Verify flow no longer applies to this recording. Teaching Recording recording-add-anvil cannot be verified from verified."
    )
  ).toBeVisible();
  expect(screen.queryByText("[object Object]")).toBeNull();
});

test("names the gesture when a refusal carries no readable message", async () => {
  const user = userEvent.setup();
  rpc.verifyFailure = { message: { code: 17 } };
  renderWorkspace(resultFor([dryRunPassedSession]), session.id);

  await user.click(await screen.findByRole("button", { name: "Verify flow" }));

  expect(
    await screen.findByText(
      "The Workspace could not connect, so Verify flow did not reach the server."
    )
  ).toBeVisible();
  expect(screen.queryByText("[object Object]")).toBeNull();
});
