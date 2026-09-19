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
  expect(
    await screen.findByRole("heading", { name: "Workspace" })
  ).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Agent Session" })).toHaveValue(
    session.id
  );
  expect(screen.getByLabelText("Live browser viewport")).toBeInTheDocument();
  expect(screen.getByText("Control")).toBeVisible();
});

test("does not use a foreign URL session id", async () => {
  renderWorkspace(resultFor([session]), "agent-foreign");
  expect(
    await screen.findByText(/not owned by this server process/u)
  ).toBeVisible();
  expect(screen.queryByLabelText("Live browser viewport")).toBeNull();
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

test("shows the active controller and the action timeline", async () => {
  renderWorkspace(
    resultFor([
      {
        ...session,
        timeline: [
          {
            actor: "agent",
            at: "2026-08-31T00:00:01.000Z",
            description: "Click e4",
            dispatched: true,
            id: "action-one",
            outcome: "completed",
          },
          {
            actor: "agent",
            at: "2026-08-31T00:00:02.000Z",
            description: "Fill e2",
            dispatched: true,
            id: "action-two",
            outcome: "failed",
          },
        ],
      } satisfies unknown,
    ]),
    session.id
  );
  expect(await screen.findByText("The agent has control")).toBeVisible();
  const timeline = screen.getByRole("list", { name: "Action timeline" });
  expect(timeline).toHaveTextContent("Click e4");
  expect(timeline).toHaveTextContent("Fill e2");
});

test("discloses Teaching capture counts and the drafted Flow Skill", async () => {
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
        teaching: { actionCount: 4, instructionCount: 2 },
      } satisfies unknown,
    ]),
    session.id
  );
  expect(
    await screen.findByRole("heading", { name: "Teaching" })
  ).toBeVisible();
  expect(
    screen.getByRole("option", {
      name: "browse-catalogue",
    })
  ).toBeVisible();
  expect(screen.getByText("Captured actions").nextSibling).toHaveTextContent(
    "4"
  );
  expect(screen.getByText("Instructions").nextSibling).toHaveTextContent("2");
  expect(
    screen.getByText(/every raw artifact is deleted once you verify/u)
  ).toBeVisible();
});

test("does not show Teaching details for an Interactive Run", async () => {
  renderWorkspace(resultFor([session]), session.id);
  await screen.findByRole("heading", { name: "Workspace" });
  expect(screen.queryByRole("heading", { name: "Teaching" })).toBeNull();
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
  expect(await screen.findByText("You have control")).toBeVisible();
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
        teaching: { actionCount: 0, instructionCount: 0 },
      } satisfies unknown,
    ]),
    session.id
  );
  expect(
    await screen.findByText("You are demonstrating this journey")
  ).toBeVisible();
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
    teaching: { actionCount: 0, instructionCount: 0 },
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
        teaching: { actionCount: 0, instructionCount: 0 },
      } satisfies unknown,
    ]),
    session.id
  );
  expect(
    await screen.findByRole("heading", { name: "Teaching" })
  ).toBeVisible();
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
  teaching: { actionCount: 0, instructionCount: 0 },
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
        text: "button: Place order: Use the express checkout here.",
      },
      type: "agent.teaching.instruction.record",
    },
  });
  // The comment count is the only instruction surface the dock adds.
  expect(await screen.findByText("1 comment")).toBeVisible();
  expect(screen.queryByLabelText("Add instruction")).toBeNull();
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
  expect(await screen.findByText("1 comment")).toBeVisible();

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
  expect(screen.queryByText("1 comment")).toBeNull();
  expect(screen.queryByLabelText("Describe the change")).toBeNull();
});

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
  teaching: { actionCount: 4, instructionCount: 0 },
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
