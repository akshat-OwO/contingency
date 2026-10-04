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
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { routeTree } from "@/routeTree.gen";

const rpc = vi.hoisted(() => ({
  agentStreamFailureMessage: undefined,
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
  instructionFailure: undefined satisfies unknown,
  /* A failing save settles only once the test opens this gate. */
  instructionGate: Promise.resolve(true),
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
  takeoverFailure: undefined satisfies unknown,
  /* A Takeover settles only once the test opens this gate. */
  takeoverGate: Promise.resolve(true),
  /* How many Takeovers have answered, so a test can wait for one to land. */
  takeoverSettled: 0,
  verifyFailure: undefined satisfies unknown,
  /* A verification settles only once the test opens this gate. */
  verifyGate: Promise.resolve(true),
  verifyResponse: {} satisfies unknown,
  verifySettled: 0,
}));

/** The draft review is not what this test reads, so its revision never lands. */

const rpcOverrides = {
  agentBrowserElementInspectMutation: Atom.fn(() =>
    Effect.sync(() => ({ element: rpc.inspectedElement }))
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
  agentSessionStartMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.startSessionCalls.push(payload);
      return { session: rpc.startedSession };
    })
  ),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
  agentTakeoverMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.takeoverCalls.push(payload);
    }).pipe(
      Effect.andThen(Effect.promise(() => rpc.takeoverGate)),
      Effect.tap(() =>
        Effect.sync(() => {
          rpc.takeoverSettled += 1;
        })
      ),
      Effect.andThen(
        rpc.takeoverFailure === undefined
          ? Effect.succeed({})
          : Effect.fail(rpc.takeoverFailure)
      )
    )
  ),
  agentTeachingFlowRenameMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.sync(() => {
      rpc.renameCalls.push(payload);
      return {};
    })
  ),
  agentTeachingFlowVerifyMutation: Atom.fn(() =>
    rpc.verifyFailure === undefined
      ? Effect.promise(() => rpc.verifyGate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              rpc.verifySettled += 1;
              return rpc.verifyResponse;
            })
          )
        )
      : Effect.fail(rpc.verifyFailure)
  ),
  agentTeachingInstructionRecordMutation: Atom.fn(
    <Payload,>(payload: Payload) =>
      rpc.instructionFailure === undefined
        ? Effect.sync(() => {
            rpc.instructionCalls.push(payload);
            return {
              session: {
                activity: "teaching",
                teaching: { instructionCount: rpc.instructionCalls.length },
              },
            };
          })
        : Effect.promise(() => rpc.instructionGate).pipe(
            Effect.andThen(Effect.fail(rpc.instructionFailure))
          )
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
  runVideoStatusAtom: () =>
    Atom.make(() => ({
      _tag: "Success",
      value: { condensed: true, state: "ready" },
      waiting: false,
    })),
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
  pendingDecisions: [],
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
    coverage: { complete: false, executed: 1, total: 2, unexecuted: 1 },
    endedAt: null,
    flowSkillName: "browse-catalogue",
    inputs: [],
    // The agent has just acted, so the dock has no idleness to report.
    lastAgentActivityAt: new Date().toISOString(),
    outcome: null,
    runId: "agentrun-one",
    startedAt: "2026-08-31T00:00:00.000Z",
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
  value: { sessions },
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
  rpc.takeoverFailure = undefined;
  rpc.takeoverGate = Promise.resolve(true);
  rpc.takeoverSettled = 0;
  rpc.verifyFailure = undefined;
  rpc.verifyGate = Promise.resolve(true);
  rpc.verifyResponse = {};
  rpc.verifySettled = 0;
  rpc.instructionFailure = undefined;
  rpc.instructionGate = Promise.resolve(true);
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
    payload: { activity: "teaching" },
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

test("keeps a prerequisite refusal visible after its request closes", async () => {
  renderWorkspace(
    resultFor([
      {
        ...dryRunSession,
        pendingDecisions: [],
        run: {
          assessment: null,
          findings: [],
          inputs: [],
          instructions: [],
          lifecycle: { phase: "running" },
          purpose: {
            flowSkillName: "add-anvil",
            kind: "dry-run",
            recordingId: "recording-add-anvil",
            takeoverOccurred: false,
          },
          referencedSkills: [],
          requestedTask: "Add an anvil.",
          schemaVersion: 3,
          variables: [
            {
              flowSkillName: "login",
              lastAnswer: "refused",
              name: "PASSWORD",
              runtime: true,
              secret: true,
              supplied: false,
            },
          ],
        },
      },
    ]),
    session.id
  );
  expect(
    await screen.findByRole("region", { name: "Prerequisite Variables" })
  ).toHaveTextContent("login/PASSWORD refused");
  expect(screen.queryByRole("textbox", { name: "login/PASSWORD" })).toBeNull();
});

test("a live Run offers no ceiling to extend", async () => {
  renderWorkspace(resultFor([runningSession]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Agent Step 2 of 2.");
  expect(screen.queryByRole("button", { name: /ceiling/iu })).toBeNull();
  expect(dock).not.toHaveTextContent("Agent idle");
});

test("says how long an idle agent has been quiet without ending the Run", async () => {
  renderWorkspace(
    resultFor([
      {
        ...runningSession,
        run: {
          ...runningSession.run,
          lastAgentActivityAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        },
      } satisfies unknown,
    ]),
    session.id
  );
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("Agent idle for 12 min");
  // The notice is read-only: the one control is still the one on offer.
  expect(screen.getByRole("button", { name: "Take control" })).toBeVisible();
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

test("names who held the browser when a Run ended, without a control", async () => {
  renderWorkspace(
    resultFor([{ ...session, controller: "user", phase: "closed" }]),
    session.id
  );
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(dock).toHaveTextContent("You had control.");
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
    payload: { sessionId: session.id },
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
    payload: { sessionId: session.id },
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
      action: { action: "back", type: "history" },
      sessionId: session.id,
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
      action: { type: "navigate", url: "https://example.org/pricing" },
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
      inputs: [{ deltaY: 240, eventType: "mouseWheel", type: "input_mouse" }],
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
  expect(within(dock).getByRole("button", { name: "Comment" })).toBeVisible();
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
    within(dock).getByRole("button", { name: "Comment" }),
    within(dock).getByRole("button", { name: "Stop recording" }),
  ];
  for (const control of controls) {
    control.focus();
    expect(control).toHaveFocus();
  }
  await user.tab();
  expect(dock).not.toHaveFocus();
});

test("attaches an inspected element to a comment", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(await screen.findByRole("button", { name: "Comment" }));
  const composer = await screen.findByRole("dialog", { name: "Comment" });
  await user.click(
    within(composer).getByRole("button", { name: /Attach element/u })
  );
  // Picking closes the composer so the whole Page can be pointed at.
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByText("Click an element to attach it")).toBeVisible();
  const canvas = screen.getByLabelText("Live browser viewport");
  // SAFETY: while recording, the comment layer is the canvas's next sibling.
  await user.click(canvas.nextElementSibling as Element);

  // The picked element lands in the reopened composer as a removable chip.
  const reopened = await screen.findByRole("dialog", { name: "Comment" });
  expect(
    within(reopened).getByRole("button", { name: "Remove attached element" })
  ).toBeVisible();
  expect(reopened).toHaveTextContent("button: Place order");
  const field = within(reopened).getByRole("textbox", { name: "Comment" });
  await waitFor(() => {
    expect(field).toHaveFocus();
  });
  await user.type(field, "Use the express checkout here.{Enter}");

  await waitFor(() => {
    expect(rpc.instructionCalls).toHaveLength(1);
  });
  expect(rpc.instructionCalls[0]).toMatchObject({
    payload: {
      sessionId: session.id,
      target: "button: Place order",
      text: "Use the express checkout here.",
    },
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  // The comment's element keeps a numbered pin on the Page.
  expect(canvas.nextElementSibling).toHaveTextContent("1");
});

test("adds a page comment without inspecting an element", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(await screen.findByRole("button", { name: "Comment" }));
  const field = await screen.findByRole("textbox", { name: "Comment" });
  await user.type(field, "Dismiss the cookie banner if it shows.");
  await user.click(screen.getByRole("button", { name: /Add comment/u }));
  await waitFor(() => {
    expect(rpc.instructionCalls).toHaveLength(1);
  });
  expect(rpc.instructionCalls[0]).toMatchObject({
    payload: { text: "Dismiss the cookie banner if it shows." },
  });
  expect(rpc.instructionCalls[0]).not.toMatchObject({
    payload: { target: expect.any(String) },
  });
});

test("reopens the composer on the unsent draft when a save fails after it was closed", async () => {
  const user = userEvent.setup();
  rpc.instructionFailure = new Error("The recording refused the instruction.");
  const gate = Promise.withResolvers<boolean>();
  rpc.instructionGate = gate.promise;
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(await screen.findByRole("button", { name: "Comment" }));
  const field = await screen.findByRole("textbox", { name: "Comment" });
  await user.type(field, "Dismiss the cookie banner.{Enter}");
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  gate.resolve(true);
  const reopened = await screen.findByRole("dialog", { name: "Comment" });
  expect(await within(reopened).findByRole("alert")).toHaveTextContent(
    "The recording refused the instruction."
  );
  expect(
    within(reopened).getByRole("textbox", { name: "Comment" })
  ).toHaveValue("Dismiss the cookie banner.");
});

test("keeps single-key shortcuts for the Page while the browser holds focus", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  const trigger = within(dock).getByRole("button", { name: "Comment" });
  // Outside the Page the hint is the single key.
  expect(trigger).toHaveTextContent("/");

  const canvas = screen.getByLabelText("Live browser viewport");
  canvas.focus();
  await waitFor(() => {
    expect(trigger).toHaveTextContent("Ctrl");
  });
  rpc.inputCalls.length = 0;
  await user.keyboard("/");
  await waitFor(() => {
    expect(rpc.inputCalls.length).toBeGreaterThan(0);
  });
  expect(screen.queryByRole("dialog")).toBeNull();

  // The chord is Contingency's: it opens the composer and never reaches the Page.
  rpc.inputCalls.length = 0;
  await user.keyboard("{Control>}{Shift>}K{/Shift}{/Control}");
  expect(await screen.findByRole("dialog", { name: "Comment" })).toBeVisible();
  const forwarded = JSON.stringify(rpc.inputCalls);
  expect(forwarded).not.toContain('"key":"K"');
  expect(forwarded).not.toContain('"key":"k"');
});

test("opens the composer with a single key outside the Page", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await screen.findByRole("region", { name: "Workspace dock" });
  await user.keyboard("/");
  const composer = await screen.findByRole("dialog", { name: "Comment" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(composer).not.toBeInTheDocument();
  });
  await user.keyboard("i");
  expect(screen.getByText("Click an element to attach it")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByText("Click an element to attach it")).toBeNull();
  });
});

test("reads earlier comments back in the composer", async () => {
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
  await user.click(
    await screen.findByRole("button", { name: "Comment, 2 comments so far" })
  );
  const list = await screen.findByRole("list", { name: "Earlier comments" });
  const items = within(list).getAllByRole("listitem");
  // Newest first: the instruction just attached is the one being checked.
  expect(items[0]).toHaveTextContent("Stop once the receipt shows.");
  expect(items[0]).toHaveTextContent("0:02");
  expect(items[0]).toHaveTextContent("Page");
  expect(items[1]).toHaveTextContent("Use the express checkout here.");
  expect(items[1]).toHaveTextContent("button: Place order");

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("list", { name: "Earlier comments" })).toBeNull();
  });
});

test("names no count on the comment trigger when nothing is attached", async () => {
  renderWorkspace(resultFor([teachingRecording]), session.id);
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(within(dock).getByRole("button", { name: "Comment" })).toBeVisible();
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
    payload: { name: "place-order", sessionId: session.id },
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
  await user.click(screen.getByRole("button", { name: "Delete recording" }));
  await waitFor(() => {
    expect(rpc.discardCalls).toHaveLength(1);
  });
  expect(rpc.discardCalls[0]).toMatchObject({
    payload: { sessionId: session.id },
  });
});

test("leaves the composer and its pins with the recording they belong to", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([teachingRecording]), session.id);
  await user.click(await screen.findByRole("button", { name: "Comment" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Comment" }),
    "Half-written comment"
  );

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
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Comment/u })).toBeNull();
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

test("leaves the hand-off to an agent to the user's own prompt", async () => {
  // The dock was cluttered with clipboard hand-offs; the user prompts their
  // agent themselves, so no state offers one (#297).
  renderWorkspace(resultFor([teachingReady]), session.id);
  expect(
    await screen.findByRole("button", { name: "Delete recording" })
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Copy/u })).toBeNull();

  cleanup();
  renderWorkspace(resultFor([teachingDrafted]), session.id);
  await screen.findByText("Flow skill drafted");
  expect(screen.queryByRole("button", { name: /^Copy/u })).toBeNull();
  // A button reading "Dry run" started nothing, which read as a broken
  // build (#210).
  expect(screen.queryByRole("button", { name: "Dry run" })).toBeNull();
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

const dryRunFailedSession = {
  ...dryRunPassedSession,
  captureState: {
    ...dryRunPassedSession.captureState,
    _tag: "dry-run-failed",
    dryRunEndedAt: "2026-08-31T00:00:08.000Z",
    dryRunResult: {
      completedAt: "2026-08-31T00:00:08.000Z",
      inputs: [],
      observableOutcome:
        "The Add to cart step never saw the anvil in the cart, so its Done when line did not hold.",
      outcome: "failed",
    },
    dryRunSessionId: "agent-dry-test",
  },
} satisfies unknown;

test("keeps a failed Dry Run's explanation behind the details button", async () => {
  const user = userEvent.setup();
  renderWorkspace(resultFor([dryRunFailedSession]), session.id);
  const explanation =
    "The Add to cart step never saw the anvil in the cart, so its Done when line did not hold.";

  // The dock shows the state, not the explanation, so it stays one row (#297).
  const dock = await screen.findByRole("region", { name: "Workspace dock" });
  expect(await within(dock).findByText("Dry run failed")).toBeVisible();
  expect(within(dock).queryByText(explanation)).toBeNull();

  // With no Dry Run Summary to read it from, the popover is where it lives.
  await user.click(within(dock).getByRole("button", { name: "Show details" }));
  expect(await screen.findByText(explanation)).toBeVisible();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByText(explanation)).toBeNull();
  });
});

test("shows a Dry Run's assessments and video beside verification", async () => {
  const dryRunSummary = {
    assessmentCounts: {
      blocked: 0,
      inconclusive: 0,
      notWorking: 0,
      working: 1,
    },
    attribution: {
      clientName: "verify",
      clientVersion: "1",
      reportedMetadataVerified: false,
      reportedModel: null,
      reportedProvider: null,
    },
    coverage: { complete: true, executed: 1, total: 1, unexecuted: 0 },
    endedAt: "2026-08-31T00:00:08.000Z",
    flowSkillName: "add-anvil",
    inputs: [],
    outcome: "completed",
    runId: "agentrun-dry-test",
    schemaVersion: 2,
    sessionId: "agent-dry-test",
    startedAt: "2026-08-31T00:00:06.000Z",
    steps: [
      {
        assessment: {
          attempts: 1,
          evidence: [{ id: "snapshot-1", kind: "snapshot" }],
          explanation: "The anvil is in the cart.",
          outcome: "working",
          submittedAt: "2026-08-31T00:00:08.000Z",
        },
        attempts: 1,
        confirmation: false,
        description: "Add the anvil.",
        doneWhen: "the anvil is in the cart.",
        endedAt: "2026-08-31T00:00:08.000Z",
        execution: "assessed",
        index: 0,
        name: "Add anvil",
        startedAt: "2026-08-31T00:00:06.000Z",
      },
    ],
    timeline: [],
    title: "Add anvil",
    tracePath: "agent-dry-test.trace.zip",
    videoPath: "agent-dry-test.webm",
  };
  const withSummary = {
    ...dryRunPassedSession,
    captureState: { ...dryRunPassedSession.captureState, dryRunSummary },
  };
  renderWorkspace(resultFor([withSummary]), session.id);

  expect(
    await screen.findByRole("complementary", { name: "Dry Run Summary" })
  ).toBeVisible();
  expect(screen.getByText("The anvil is in the cart.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Verify flow" })).toBeVisible();
  expect(screen.getByLabelText("Recorded Run video")).toHaveAttribute(
    "src",
    "/teaching-recordings/recording-add-anvil/dry-run/video"
  );
});

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

const otherRunSession = {
  ...session,
  id: "agent-two",
  viewUrl: "http://127.0.0.1:7777/?session=agent-two",
} satisfies unknown;

test("keeps a Takeover's pending state and failure with the session it was asked for", async () => {
  const user = userEvent.setup();
  rpc.takeoverFailure = new Error("The agent session refused the Takeover.");
  const gate = Promise.withResolvers<boolean>();
  rpc.takeoverGate = gate.promise;
  renderWorkspace(resultFor([session, otherRunSession]), session.id);
  const takeControl = await screen.findByRole("button", {
    name: "Take control",
  });
  await user.click(takeControl);
  await waitFor(() => {
    expect(takeControl).toBeDisabled();
  });

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Agent Session" }),
    otherRunSession.id
  );
  const otherControl = await screen.findByRole("button", {
    name: "Take control",
  });
  await waitFor(() => {
    expect(otherControl).toBeEnabled();
  });

  gate.resolve(true);
  // The failure belongs to the first session, so the second never shows it.
  await waitFor(() => {
    expect(rpc.takeoverSettled).toBe(1);
  });
  expect(
    screen.queryByText("The agent session refused the Takeover.")
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Take control" })).toBeEnabled();

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Agent Session" }),
    session.id
  );
  expect(
    await screen.findByText("The agent session refused the Takeover.")
  ).toBeVisible();
});

test("ignores a repeated Takeover while one is in flight, and clears its failure on retry", async () => {
  const user = userEvent.setup();
  rpc.takeoverFailure = new Error("The agent session refused the Takeover.");
  const gate = Promise.withResolvers<boolean>();
  rpc.takeoverGate = gate.promise;
  renderWorkspace(resultFor([session]), session.id);
  const takeControl = await screen.findByRole("button", {
    name: "Take control",
  });
  // Two clicks before the first render can disable the button.
  takeControl.click();
  takeControl.click();
  gate.resolve(true);
  expect(
    await screen.findByText("The agent session refused the Takeover.")
  ).toBeVisible();
  expect(rpc.takeoverCalls).toHaveLength(1);

  const retry = Promise.withResolvers<boolean>();
  rpc.takeoverGate = retry.promise;
  await user.click(screen.getByRole("button", { name: "Take control" }));
  await waitFor(() => {
    expect(
      screen.queryByText("The agent session refused the Takeover.")
    ).toBeNull();
  });
  retry.resolve(true);
});

test("shows a Takeover's outcome after the Workspace remounts mid-request", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error");
  rpc.takeoverFailure = new Error("The agent session refused the Takeover.");
  const gate = Promise.withResolvers<boolean>();
  rpc.takeoverGate = gate.promise;
  rpc.sessionsResult = resultFor([session]);
  const workspace = (mounted: boolean) => (
    <TestRegistry>
      {mounted ? <AgentWorkspace requestedSessionId={session.id} /> : null}
    </TestRegistry>
  );
  const { rerender } = render(workspace(true));
  await user.click(await screen.findByRole("button", { name: "Take control" }));
  await waitFor(() => {
    expect(rpc.takeoverCalls).toHaveLength(1);
  });

  rerender(workspace(false));
  gate.resolve(true);
  await waitFor(() => {
    expect(rpc.takeoverSettled).toBe(1);
  });
  rerender(workspace(true));

  expect(
    await screen.findByText("The agent session refused the Takeover.")
  ).toBeVisible();
  expect(consoleError).not.toHaveBeenCalled();
});

test("applies a verification only to the Teaching session it was asked for", async () => {
  const user = userEvent.setup();
  const otherDryRunPassed = {
    ...dryRunPassedSession,
    flowSkillName: "remove-anvil",
    id: "agent-two",
    recordingId: "recording-remove-anvil",
  } satisfies unknown;
  const gate = Promise.withResolvers<boolean>();
  rpc.verifyGate = gate.promise;
  rpc.verifyResponse = {
    captureState: {
      ...dryRunFailedSession.captureState,
      _tag: "verified",
      verifiedAt: "2026-08-31T00:00:09.000Z",
    },
    cleanup: null,
  };
  renderWorkspace(
    resultFor([dryRunPassedSession, otherDryRunPassed]),
    session.id
  );
  await user.click(await screen.findByRole("button", { name: "Verify flow" }));

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Agent Session" }),
    otherDryRunPassed.id
  );
  const otherVerify = await screen.findByRole("button", {
    name: "Verify flow",
  });
  // The first session's verification is in flight, not this session's.
  await waitFor(() => {
    expect(otherVerify).toBeEnabled();
  });

  gate.resolve(true);
  await waitFor(() => {
    expect(rpc.verifySettled).toBe(1);
  });
  expect(screen.getByRole("button", { name: "Verify flow" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Agent Session" })).toHaveValue(
    otherDryRunPassed.id
  );
});
