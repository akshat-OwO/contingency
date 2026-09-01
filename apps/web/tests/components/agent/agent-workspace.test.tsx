import { RegistryProvider } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { afterEach, expect, test, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  agentStreamFailureMessage: undefined as string | undefined,
  inputCalls: [] as unknown[],
  navigateCalls: [] as unknown[],
  returnControlCalls: [] as unknown[],
  sessionsResult: {
    _tag: "Initial" as const,
    waiting: true,
  } as unknown,
  takeoverCalls: [] as unknown[],
}));

vi.mock("@/lib/rpc", () => ({
  agentBrowserFrameAckMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserInputMutation: Atom.fn((payload: unknown) =>
    Effect.sync(() => {
      rpc.inputCalls.push(payload);
      return {};
    })
  ),
  agentBrowserNavigateMutation: Atom.fn((payload: unknown) =>
    Effect.sync(() => {
      rpc.navigateCalls.push(payload);
      return {};
    })
  ),
  agentReturnControlMutation: Atom.fn((payload: unknown) =>
    Effect.sync(() => {
      rpc.returnControlCalls.push(payload);
      return {};
    })
  ),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
  agentTakeoverMutation: Atom.fn((payload: unknown) =>
    Effect.sync(() => {
      rpc.takeoverCalls.push(payload);
      return {};
    })
  ),
  runAgentBrowserStream: () => Effect.never,
  runAgentSessionStream: () =>
    rpc.agentStreamFailureMessage === undefined
      ? Effect.never
      : Effect.fail(new Error(rpc.agentStreamFailureMessage)),
}));

const { AgentWorkspace } = await import("@/components/agent/agent-workspace");
const { routeTree } = await import("@/routeTree.gen");

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
  takeover: null,
  timeline: [],
  updatedAt: "2026-08-31T00:00:00.000Z",
  viewUrl: "http://127.0.0.1:7777/agent?session=agent-one",
} as const;

type Session = typeof session;

const resultFor = (sessions: readonly Session[]) => ({
  _tag: "Success" as const,
  value: {
    data: { sessions },
    type: "agent.sessions.result" as const,
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
      <RegistryProvider>
        <AgentWorkspace requestedSessionId={requestedSessionId} />
      </RegistryProvider>
    );
  })();

afterEach(() => {
  cleanup();
  rpc.agentStreamFailureMessage = undefined;
  rpc.inputCalls = [];
  rpc.navigateCalls = [];
  rpc.returnControlCalls = [];
  rpc.takeoverCalls = [];
});

test("announces that Agent Sessions are loading", () => {
  renderWorkspace({ _tag: "Initial", waiting: true });
  expect(screen.getByText("Loading Agent Sessions…")).toBeVisible();
});

test("explains when this MCP process has no active sessions", async () => {
  renderWorkspace(resultFor([]));
  expect(await screen.findByText("No active Agent Sessions")).toBeVisible();
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
    await screen.findByRole("heading", { name: "Agent View" })
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
    await screen.findByText(/not owned by this MCP process/u)
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
    viewUrl: "http://127.0.0.1:7777/agent?session=agent-two",
  };
  rpc.sessionsResult = resultFor([session, secondSession]);
  const history = createMemoryHistory({
    initialEntries: [`/agent?session=${session.id}`],
  });
  const testRouter = createRouter({ history, routeTree });
  await testRouter.load();
  render(
    <RegistryProvider>
      <RouterProvider router={testRouter} />
    </RegistryProvider>
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
      } as unknown as Session,
    ]),
    session.id
  );
  expect(await screen.findByText("The agent has control")).toBeVisible();
  const timeline = screen.getByRole("list", { name: "Action timeline" });
  expect(timeline).toHaveTextContent("Click e4");
  expect(timeline).toHaveTextContent("Fill e2");
});

test("takes control from Agent View and returns it explicitly", async () => {
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
      } as unknown as Session,
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
      } as unknown as Session,
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
} as unknown as Session;

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
