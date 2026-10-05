import { setTimeout as delay } from "node:timers/promises";

import type { AgentSessionSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
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

/**
 * Workspace refreshes constantly while a session is live, and the paused
 * Execution Boundary is gated on a field of the session snapshot. This test
 * drives the whole workspace through enough updates for retained state to be
 * collected.
 */
const rpc = vi.hoisted(() => ({
  emit: undefined,
  sessionsResult: undefined,
}));

const rpcOverrides = {
  agentBrowserFrameAckMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserInputMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserNavigateMutation: Atom.fn(() => Effect.succeed({})),
  agentReturnControlMutation: Atom.fn(() => Effect.succeed({})),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
  agentTakeoverMutation: Atom.fn(() => Effect.succeed({})),
  runAgentBrowserStream: () => Effect.never,
  runAgentSessionStream: (
    _sessionId: string,
    onEvent: (snapshot: AgentSessionSnapshot) => Effect.Effect<void>
  ) =>
    Effect.callback<never>(() => {
      rpc.emit = (snapshot) => {
        Effect.runFork(onEvent(snapshot));
      };
    }),
};

const TestRegistry = ({ children }: { readonly children: ReactNode }) => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <RegistryProvider>{children}</RegistryProvider>
  </RpcDependenciesProvider>
);

const at = "2026-09-02T00:00:00.000Z";

const sessionAt = <Overrides extends object>(
  updatedAt: string,
  overrides?: Overrides
) => ({
  activity: "teaching",
  boundary: null,
  captureState: { _tag: "recording", startedAt: at },
  clientName: "Test agent",
  clientVersion: "1.0",
  controller: "agent",
  createdAt: at,
  currentUrl: "https://shop.example.com/",
  flowSkillName: "shop-sign-in",
  id: "agent-one",
  interruptedAction: null,
  ownerProcessId: "mcp-test",
  pendingDecisions: [],
  phase: "running",
  recordingId: "recording-shop-sign-in",
  run: null,
  takeover: null,
  teaching: { actionCount: 2, instructionCount: 0, instructions: [] },
  timeline: [],
  updatedAt,
  viewUrl: "http://127.0.0.1:7777/?session=agent-one",
  ...overrides,
});

/** A paused confirmation Boundary and its pending decision, by id. */
const boundaryFor = (id: string) => ({
  action: { ref: "e55", type: "click" },
  description: "Submit the return for RH-1042",
  id,
  operationId: `submit-${id}`,
  reason: "confirmation",
  requested: "Submit the return for RH-1042",
});
const pendingFor = (id: string) => ({
  boundaryId: id,
  createdAt: at,
  kind: "boundary",
  pendingDecisionId: `pending-${id}-2ca483b9-83b0-442f`,
  scopeSummary: "Submit the return for RH-1042",
  sessionId: "agent-one",
  variable: null,
});

const renderWorkspace = () => {
  rpc.sessionsResult = {
    _tag: "Success",
    value: { sessions: [sessionAt(at)] },
    waiting: false,
  };
  return render(
    <TestRegistry>
      <AgentWorkspace requestedSessionId="agent-one" />
    </TestRegistry>
  );
};

afterEach(() => {
  cleanup();
  rpc.emit = undefined;
});

test("keeps an Execution Boundary on screen through a burst of updates", async () => {
  renderWorkspace();
  await screen.findByRole("region", { name: "Workspace dock" });

  const boundary = {
    action: { type: "click" },
    description: "Click Place order",
    id: "boundary-1",
    operationId: "op-1",
    reason: "confirmation",
    requested: "https://shop.example.com/checkout",
  };
  rpc.emit?.(sessionAt("2026-09-02T00:00:01.000Z", { boundary }));
  const shown = await screen.findByText("https://shop.example.com/checkout");

  const captureAction = async (entry: number) => {
    rpc.emit?.(
      sessionAt(`2026-09-02T00:00:0${entry}.000Z`, {
        boundary,
        timeline: [
          {
            actor: "agent",
            at,
            description: `Captured action ${entry}`,
            dispatched: true,
            id: `entry-${entry}`,
            outcome: "completed",
          },
        ],
      })
    );
    await delay(200);
  };
  await captureAction(2);
  await captureAction(3);
  await captureAction(4);
  await captureAction(5);

  expect(screen.getByText("https://shop.example.com/checkout")).toBe(shown);
});

test("clears the paused Boundary from the browser during Takeover and restores it on return", async () => {
  renderWorkspace();
  await screen.findByRole("region", { name: "Workspace dock" });
  const boundary = {
    action: { type: "click" },
    description: "Submit return",
    id: "boundary-return",
    operationId: "submit-return",
    reason: "confirmation",
    requested: "Submit the return for RH-1042",
  };
  const run = { activity: "run", captureState: null, teaching: null };
  rpc.emit?.(sessionAt("2026-09-02T00:00:01.000Z", { ...run, boundary }));
  await screen.findByRole("region", { name: "Execution Boundary" });

  rpc.emit?.(
    sessionAt("2026-09-02T00:00:02.000Z", {
      ...run,
      boundary,
      controller: "user",
      phase: "takeover",
    })
  );
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Execution Boundary" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Browser address" })
    ).toBeEnabled();
  });

  await screen.findByRole("button", { name: "Return control" });
  rpc.emit?.(sessionAt("2026-09-02T00:00:03.000Z", { ...run, boundary }));
  await screen.findByRole("region", { name: "Execution Boundary" });
  expect(screen.getByText(/in your agent conversation/u)).toBeInTheDocument();
  expect(
    screen.getByRole("textbox", { name: "Browser address" })
  ).toBeDisabled();

  rpc.emit?.(sessionAt("2026-09-02T00:00:04.000Z", run));
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Execution Boundary" })
    ).not.toBeInTheDocument();
  });
});

test("holds a paused Boundary in the dock and reopens a folded tier for a new one", async () => {
  const user = userEvent.setup();
  renderWorkspace();
  await screen.findByRole("region", { name: "Workspace dock" });
  const run = { activity: "run", captureState: null, teaching: null };
  rpc.emit?.(
    sessionAt("2026-09-02T00:00:01.000Z", {
      ...run,
      boundary: boundaryFor("boundary-1"),
      pendingDecisions: [pendingFor("boundary-1")],
    })
  );
  // A Run's dock replaces the Teaching one, so it is read after the switch.
  const boundary = await screen.findByRole("region", {
    name: "Execution Boundary",
  });
  const dock = screen.getByRole("region", { name: "Workspace dock" });
  expect(dock).toContainElement(boundary);
  expect(
    within(boundary).getByRole("heading", { name: "Confirm this action" })
  ).toBeVisible();
  // A description that repeats the request is not shown twice.
  expect(
    within(boundary).getAllByText("Submit the return for RH-1042")
  ).toHaveLength(1);
  // The decision is answered in the agent conversation, never here.
  expect(
    within(boundary).queryByRole("button", { name: /^allow$/iu })
  ).toBeNull();
  expect(
    within(boundary).getByRole("button", {
      name: "Copy decision id pending-boundary-1-2ca483b9-83b0-442f",
    })
  ).toBeVisible();
  expect(boundary).not.toHaveTextContent("submit-boundary-1");
  await user.click(
    within(boundary).getByRole("button", { name: "Action details" })
  );
  expect(boundary).toHaveTextContent("submit-boundary-1");

  await user.click(
    within(dock).getByRole("button", { name: "Collapse requests" })
  );
  expect(
    within(dock).queryByRole("region", { name: "Execution Boundary" })
  ).toBeNull();
  expect(
    within(dock).getByRole("button", {
      name: "Show request: Confirm this action. Submit the return for RH-1042",
    })
  ).toBeVisible();

  // A new Boundary is a new request: the folded tier opens for it.
  rpc.emit?.(
    sessionAt("2026-09-02T00:00:02.000Z", {
      ...run,
      boundary: boundaryFor("boundary-2"),
      pendingDecisions: [pendingFor("boundary-2")],
    })
  );
  expect(
    await within(dock).findByRole("region", { name: "Execution Boundary" })
  ).toBeVisible();
});
