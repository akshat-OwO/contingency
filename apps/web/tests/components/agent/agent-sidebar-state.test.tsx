import { setTimeout as delay } from "node:timers/promises";

import type { AgentSessionSnapshot } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AgentWorkspace } from "@/components/agent/agent-workspace";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

/**
 * Agent View's sidebar refreshes constantly while a session is live, and each
 * region is gated on a field of the session snapshot. These tests drive the
 * whole workspace and let the registry's idle window elapse before asserting:
 * state the user entered must survive the region leaving the screen, which a
 * synchronous assertion would not prove.
 */
const IDLE_WINDOW = 700;

const rpc = vi.hoisted(() => ({
  detail: undefined,
  emit: undefined,
  sessionsResult: undefined,
}));

const rpcOverrides = {
  agentBrowserFrameAckMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserInputMutation: Atom.fn(() => Effect.succeed({})),
  agentBrowserNavigateMutation: Atom.fn(() => Effect.succeed({})),
  agentFlowApproveMutation: Atom.fn(() => Effect.never),
  agentFlowArchiveMutation: Atom.fn(() => Effect.never),
  agentFlowDeleteMutation: Atom.fn(() => Effect.never),
  agentFlowDraftUpdateMutation: Atom.fn(() => Effect.never),
  agentFlowRevisionAtom: () =>
    Atom.make(Effect.suspend(() => Effect.succeed({ data: rpc.detail }))),
  agentFlowVerificationAuthorizeMutation: Atom.fn(() => Effect.never),
  agentReturnControlMutation: Atom.fn(() => Effect.succeed({})),
  agentSessionsAtom: Atom.make(() => rpc.sessionsResult),
  agentTakeoverMutation: Atom.fn(() => Effect.succeed({})),
  agentTeachingVariableInputMutation: Atom.fn(() => Effect.succeed({})),
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

const evidence = [
  {
    actions: [
      {
        actor: "agent",
        description: "Navigate to the sign-in page",
        id: "action-1",
        outcome: "completed",
        urlAfter: "https://shop.example.com/sign-in",
      },
      {
        actor: "user",
        description: "Enter Variable PASSWORD in e3",
        id: "action-2",
        outcome: "completed",
        urlAfter: "https://shop.example.com/sign-in",
      },
    ],
    endedAt: at,
    hash: `sha256-${"a".repeat(64)}`,
    instructions: ["Sign in with my account."],
    screenshotCount: 2,
    startedAt: at,
    stepIndex: 0,
    urlTransitionCount: 1,
  },
];

const manifest = {
  agentFlowId: "flow-shop",
  basedOnRevisionId: null,
  compiler: { clientName: "Test agent", clientVersion: "1.0" },
  createdAt: at,
  description: "Sign in.",
  domainScope: { hosts: ["shop.example.com"] },
  emulation: {
    permissions: [],
    userAgentProfile: "default",
    viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
  },
  revisionId: "rev-1",
  schemaVersion: 1,
  sourceSessionId: "agent-one",
  status: "draft",
  steps: [
    {
      confirmation: false,
      description: "Sign in with the demonstrated account.",
      evidence: { hash: `sha256-${"a".repeat(64)}`, path: "evidence/a.json" },
      firstActionId: "action-1",
      index: 0,
      lastActionId: "action-2",
      name: "Sign in",
    },
  ],
  tags: ["shop"],
  title: "Shop sign-in",
  variables: [],
};

rpc.detail = {
  evidence,
  revision: {
    catalogRoot: "/tmp/catalog",
    heads: {
      approvedRevisionId: null,
      archived: false,
      createdAt: at,
      draftRevisionId: "rev-1",
      id: "flow-shop",
      schemaVersion: 1,
      updatedAt: at,
      verification: null,
    },
    manifest,
    path: "/tmp/catalog/agent-flows/flow-shop/revisions/rev-1",
  },
};

const savedDraft = {
  agentFlowId: "flow-shop",
  revisionId: "rev-1",
  steps: [
    {
      confirmation: false,
      description: "Sign in with the demonstrated account.",
      evidenceHash: `sha256-${"a".repeat(64)}`,
      index: 0,
      name: "Sign in",
    },
  ],
  title: "Shop sign-in",
};

const sessionAt = <Overrides extends object>(
  updatedAt: string,
  overrides?: Overrides
) => ({
  activity: "teaching",
  boundary: null,
  clientName: "Test agent",
  clientVersion: "1.0",
  controller: "agent",
  createdAt: at,
  currentUrl: "https://shop.example.com/",
  id: "agent-one",
  interruptedAction: null,
  ownerProcessId: "mcp-test",
  phase: "running",
  run: null,
  takeover: null,
  teaching: { actionCount: 2, draft: savedDraft, instructionCount: 0 },
  timeline: [],
  updatedAt,
  verification: null,
  viewUrl: "http://127.0.0.1:7777/agent?session=agent-one",
  ...overrides,
});

const renderWorkspace = () => {
  rpc.sessionsResult = {
    _tag: "Success",
    value: {
      data: { sessions: [sessionAt(at)] },
      type: "agent.sessions.result",
    },
    waiting: false,
  };
  return render(
    <TestRegistry>
      <AgentWorkspace requestedSessionId="agent-one" />
    </TestRegistry>
  );
};

/**
 * One update that omits the saved draft, as a snapshot rebuilt without it
 * would, followed by the update that carries it again. This is what takes the
 * review off screen for long enough for its state to be collected.
 */
const updateWithoutTheDraft = async () => {
  rpc.emit?.(
    sessionAt("2026-09-02T00:00:01.000Z", {
      teaching: { actionCount: 3, draft: null, instructionCount: 0 },
    })
  );
  await delay(IDLE_WINDOW);
  rpc.emit?.(sessionAt("2026-09-02T00:00:02.000Z"));
  await screen.findByLabelText("Agent Step 1 name");
};

afterEach(() => {
  cleanup();
  rpc.emit = undefined;
});

test("keeps a correction through a session update that omits the draft", async () => {
  const user = userEvent.setup();
  renderWorkspace();

  const name = await screen.findByLabelText("Agent Step 1 name");
  await user.clear(name);
  await user.type(name, "Sign in as the demo shopper");
  await updateWithoutTheDraft();

  expect(screen.getByLabelText("Agent Step 1 name")).toHaveValue(
    "Sign in as the demo shopper"
  );
});

test("keeps a Confirmation Step marker through the same update", async () => {
  const user = userEvent.setup();
  renderWorkspace();

  await user.click(
    await screen.findByRole("checkbox", {
      name: /Agent Step 1 Confirmation Step/u,
    })
  );
  await updateWithoutTheDraft();

  expect(
    screen.getByRole("checkbox", { name: /Agent Step 1 Confirmation Step/u })
  ).toBeChecked();
});

test("keeps an Execution Boundary on screen through a burst of updates", async () => {
  renderWorkspace();
  await screen.findByLabelText("Agent Step 1 name");

  const boundary = {
    action: { type: "click" },
    description: "Click Place order",
    id: "boundary-1",
    operationId: "op-1",
    reason: "confirmation",
    requested: "https://shop.example.com/checkout",
  };
  rpc.emit?.(sessionAt("2026-09-02T00:00:01.000Z", { boundary }));
  const shown = await screen.findByText("Reason: confirmation");

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

  expect(screen.getByText("Reason: confirmation")).toBe(shown);
});
