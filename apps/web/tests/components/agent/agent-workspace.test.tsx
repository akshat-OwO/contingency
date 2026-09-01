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
  sessionsResult: {
    _tag: "Initial" as const,
    waiting: true,
  } as unknown,
}));

vi.mock("@/lib/rpc", () => ({
  agentBrowserFrameAckMutation: Atom.fn(() => Effect.succeed({})),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
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
  ownerProcessId: "mcp-test",
  phase: "running",
  takeover: null,
  updatedAt: "2026-08-31T00:00:00.000Z",
  viewUrl: "http://127.0.0.1:7777/agent?session=agent-one",
} as const;

const resultFor = (sessions: readonly (typeof session)[]) => ({
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
  expect(screen.getByText("Activity")).toBeVisible();
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
