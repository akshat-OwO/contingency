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
import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { DraftReview } from "@/components/agent/draft-review";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

const rpc = vi.hoisted(() => ({
  approveCalls: [] satisfies unknown[],
  archiveCalls: [] satisfies unknown[],
  authorizeCalls: [] satisfies unknown[],
  deleteCalls: [] satisfies unknown[],
  detail: undefined,
  readError: undefined,
  writeError: undefined,
}));

const answer = () =>
  rpc.writeError === undefined
    ? Effect.succeed({ data: rpc.detail })
    : Effect.fail(new Error(rpc.writeError));

/** One atom per revision, as `@/lib/rpc` builds them, so a reread refetches. */
const revisionOf = Atom.family((_key: string) =>
  Atom.make(
    Effect.suspend(() =>
      rpc.readError === undefined
        ? Effect.succeed({ data: rpc.detail })
        : Effect.fail(new Error(rpc.readError))
    )
  )
);

const revisionFamily = (agentFlowId: string, revisionId: string) =>
  revisionOf(`${agentFlowId}\u0000${revisionId}`);

const rpcOverrides = {
  agentFlowApproveMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.suspend(() => {
      rpc.approveCalls.push(payload);
      return answer();
    })
  ),
  agentFlowArchiveMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.suspend(() => {
      rpc.archiveCalls.push(payload);
      return answer();
    })
  ),
  agentFlowDeleteMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.suspend(() => {
      rpc.deleteCalls.push(payload);
      return Effect.succeed({
        data: { agentFlowId: "flow-shop", deleted: true },
      });
    })
  ),
  agentFlowRevisionAtom: revisionFamily,
  agentFlowVerificationAuthorizeMutation: Atom.fn(
    <Payload,>(payload: Payload) =>
      Effect.suspend(() => {
        rpc.authorizeCalls.push(payload);
        return answer();
      })
  ),
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
  {
    actions: [
      {
        actor: "agent",
        description: "Click Place order",
        id: "action-3",
        outcome: "completed",
        urlAfter: "https://shop.example.com/orders/1",
      },
    ],
    endedAt: at,
    hash: `sha256-${"b".repeat(64)}`,
    instructions: [],
    screenshotCount: 1,
    startedAt: at,
    stepIndex: 1,
    urlTransitionCount: 1,
  },
];

const manifest = {
  agentFlowId: "flow-shop",
  basedOnRevisionId: null,
  compiler: { clientName: "Test agent", clientVersion: "1.0" },
  createdAt: at,
  description: "Sign in and place one order.",
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
    {
      confirmation: true,
      description: "Place the order.",
      evidence: { hash: `sha256-${"b".repeat(64)}`, path: "evidence/b.json" },
      firstActionId: "action-3",
      index: 1,
      lastActionId: "action-3",
      name: "Place the order",
    },
  ],
  tags: ["shop"],
  title: "Shop sign-in and order",
  variables: [{ name: "PASSWORD", runtime: true, secret: true }],
};

interface Verification {
  readonly assessments: readonly {
    readonly attempts: number;
    readonly evidence: readonly {
      readonly id: string;
      readonly kind: "snapshot" | "attempt";
    }[];
    readonly explanation: string;
    readonly outcome: "working" | "not-working";
    readonly stepIndex: number;
    readonly submittedAt: string;
  }[];
  readonly authorizationId: string;
  readonly authorizedAt: string;
  readonly completedAt: string | null;
  readonly revisionId: string;
  readonly sessionId: string | null;
  readonly startedAt: string | null;
  readonly status: "authorized" | "running" | "passed" | "failed";
  readonly summary: string | null;
}

const detailWith = (
  verification: Verification | null,
  overrides: Partial<typeof manifest> = {}
) => ({
  evidence,
  revision: {
    catalogRoot: "/tmp/catalog",
    heads: {
      approvedRevisionId: null,
      archived: false,
      createdAt: at,
      decisionHistory: [],
      draftRevisionId: "rev-1",
      id: "flow-shop",
      pendingDecisions:
        verification !== null &&
        (verification.revisionId !== "rev-1" ||
          verification.status === "authorized" ||
          verification.status === "running")
          ? []
          : [
              {
                agentFlowId: "flow-shop",
                createdAt: at,
                kind:
                  verification?.status === "passed"
                    ? ("approve_flow" as const)
                    : ("authorize_verification" as const),
                pendingDecisionId: "pending-review",
                revisionId: "rev-1",
                scopeSummary: "Review the exact draft scope.",
                sessionId: "agent-one",
              },
            ],
      schemaVersion: 1,
      updatedAt: at,
      verification,
    },
    manifest: { ...manifest, ...overrides },
    path: "/tmp/catalog/agent-flows/flow-shop/revisions/rev-1",
  },
});

const verificationOf = (
  status: Verification["status"],
  summary: string | null = null,
  revisionId = "rev-1"
): Verification => ({
  assessments:
    status === "authorized" || status === "running"
      ? []
      : [
          {
            attempts: 1,
            evidence: [{ id: "snapshot-1", kind: "snapshot" }],
            explanation: "The Step was checked in the fresh context.",
            outcome: status === "passed" ? "working" : "not-working",
            stepIndex: 0,
            submittedAt: at,
          },
        ],
  authorizationId: "auth-1",
  authorizedAt: at,
  completedAt: status === "passed" || status === "failed" ? at : null,
  revisionId,
  sessionId: status === "authorized" ? null : "agent-verify",
  startedAt: status === "authorized" ? null : at,
  status,
  summary,
});

const renderReview = <Detail,>(detail: Detail, refreshToken = at) => {
  rpc.detail = detail;
  return render(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken={refreshToken}
        revisionId={"rev-1"}
      />
    </TestRegistry>
  );
};

afterEach(() => {
  cleanup();
  rpc.approveCalls = [];
  rpc.archiveCalls = [];
  rpc.authorizeCalls = [];
  rpc.deleteCalls = [];
  rpc.readError = undefined;
  rpc.writeError = undefined;
});

test("shows the Agent Steps, evidence, Variables, Domain Scope, and Emulation", async () => {
  renderReview(detailWith(null));

  expect(await screen.findByText("Agent Step 1: Sign in")).toBeInTheDocument();
  expect(screen.getByText("Agent Step 2: Place the order")).toBeInTheDocument();
  expect(screen.getByText("No confirmation required.")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Confirmation Step: asks before each irreversible attempt."
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Domain Scope" })).toHaveTextContent(
    "shop.example.com"
  );
  expect(screen.getByRole("list", { name: "Variables" })).toHaveTextContent(
    "PASSWORD"
  );
  expect(screen.getByText(/default · 640 × 480/u)).toBeInTheDocument();
  expect(
    screen.getByRole("list", { name: "Agent Step 1 evidence" })
  ).toHaveTextContent("Navigate to the sign-in page");
});

test("archives an Agent Flow against the heads being reviewed", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null));

  await user.click(
    await screen.findByRole("button", { name: "Archive Agent Flow" })
  );

  await waitFor(() => {
    expect(rpc.archiveCalls).toHaveLength(1);
  });
  const [call] = rpc.archiveCalls;
  expect(call.payload.data).toMatchObject({
    agentFlowId: "flow-shop",
    archived: true,
    expectedHeads: {
      approvedRevisionId: null,
      archived: false,
      draftRevisionId: "rev-1",
    },
  });
});

test("requires typed confirmation before permanently deleting an Agent Flow", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null));

  const deleteButton = await screen.findByRole("button", {
    name: "Permanently delete Agent Flow",
  });
  expect(deleteButton).toBeDisabled();

  await user.type(
    screen.getByLabelText(
      "Type permanently-delete to confirm permanent deletion"
    ),
    "permanently-delete"
  );
  await user.click(deleteButton);

  await waitFor(() => {
    expect(rpc.deleteCalls).toHaveLength(1);
  });
  const [call] = rpc.deleteCalls;
  expect(call.payload.data).toMatchObject({
    agentFlowId: "flow-shop",
    confirmation: "permanently-delete",
    expectedHeads: {
      approvedRevisionId: null,
      archived: false,
      draftRevisionId: "rev-1",
    },
  });
});

test("does not carry deletion success into another Agent Flow review", async () => {
  const user = userEvent.setup();
  rpc.detail = detailWith(null);
  const view = render(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken={at}
        revisionId={"rev-1"}
      />
    </TestRegistry>
  );

  await user.type(
    await screen.findByLabelText(
      "Type permanently-delete to confirm permanent deletion"
    ),
    "permanently-delete"
  );
  await user.click(
    screen.getByRole("button", { name: "Permanently delete Agent Flow" })
  );
  expect(
    await screen.findByText("This Agent Flow was permanently deleted.")
  ).toBeInTheDocument();

  rpc.detail = detailWith(null, {
    agentFlowId: "flow-other",
    revisionId: "rev-other",
  });
  view.rerender(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-other"}
        refreshToken={at}
        revisionId={"rev-other"}
      />
    </TestRegistry>
  );

  expect(
    await screen.findByRole("button", { name: "Archive Agent Flow" })
  ).toBeEnabled();
  expect(
    screen.queryByText("This Agent Flow was permanently deleted.")
  ).not.toBeInTheDocument();
});

test("shows archive conflicts with the retirement controls", async () => {
  const user = userEvent.setup();
  rpc.writeError = "The Agent Flow changed before it could be archived.";
  renderReview(detailWith(null));

  await user.click(
    await screen.findByRole("button", { name: "Archive Agent Flow" })
  );

  const retirement = screen.getByRole("heading", {
    name: "Retire Agent Flow",
  }).parentElement;
  if (retirement === null) {
    throw new Error("The retirement controls were not rendered.");
  }
  expect(
    await within(retirement).findByText(
      "The Agent Flow changed before it could be archived."
    )
  ).toBeInTheDocument();
});

test("shows authorization pending in the agent conversation without an action button", async () => {
  renderReview(detailWith(null));

  expect(
    await screen.findByText("verification authorization")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Authorize Verification Run" })
  ).not.toBeInTheDocument();
  expect(rpc.authorizeCalls).toHaveLength(0);
});

test("does not invent a pending decision when the catalog exposes none", async () => {
  const detail = detailWith(null);
  detail.revision.heads.pendingDecisions = [];
  renderReview(detail);

  expect(
    await screen.findByText(/Authorize or refuse this exact draft/u)
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Pending in the agent conversation/u)
  ).not.toBeInTheDocument();
});

test("shows a failed Verification Run retry as pending in conversation", async () => {
  rpc.detail = detailWith(verificationOf("failed", "The basket stayed empty."));
  render(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken={at}
        revisionId={"rev-1"}
      />
    </TestRegistry>
  );

  expect(
    await screen.findByText("verification authorization")
  ).toBeInTheDocument();
  expect(rpc.authorizeCalls).toHaveLength(0);
});

test("offers no approval until a Verification Run has passed", async () => {
  renderReview(detailWith(verificationOf("authorized")));

  expect(
    await screen.findByText(/Verification is authorized for this draft/u)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
});

test("reports a failed Verification Run and offers another authorization", async () => {
  renderReview(
    detailWith(verificationOf("failed", "The basket stayed empty.")),
    "agent-one"
  );

  expect(
    await screen.findByText(/The basket stayed empty\./u)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Any existing Approved Agent Flow is unchanged\./u)
  ).toBeInTheDocument();
  expect(screen.getByText("verification authorization")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("list", { name: "Verification Step verdicts" })
  ).toHaveTextContent("Step 1: Sign in");
  expect(screen.getByText("not-working")).toBeInTheDocument();
  expect(screen.getByText(/snapshot snapshot-1/u)).toBeInTheDocument();
});

test("shows exact-revision approval pending without an action button", async () => {
  renderReview(
    detailWith(verificationOf("passed", "Both Agent Steps worked.")),
    "agent-one"
  );

  expect(await screen.findByText("flow approval")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
  expect(rpc.approveCalls).toHaveLength(0);
});

test("treats an authorization for another revision as no authorization", async () => {
  renderReview(
    detailWith(verificationOf("passed", "It worked.", "rev-previous")),
    "agent-one"
  );

  expect(
    await screen.findByText(/Authorize or refuse this exact draft/u)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
});

test("does not expose verification gestures when a write would be stale", async () => {
  renderReview(detailWith(null));
  rpc.writeError = "Agent Flow flow-shop draft head is rev-2, not rev-1.";

  expect(
    await screen.findByText("verification authorization")
  ).toBeInTheDocument();
  expect(rpc.authorizeCalls).toHaveLength(0);
});

test("keeps draft review read-only and directs corrections to the conversation", async () => {
  renderReview(detailWith(null));

  expect(
    await screen.findByText("verification authorization")
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Agent Step 1 name")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save corrections" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Merge with next Step" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/describe the change in your agent conversation/u)
  ).toBeInTheDocument();
});

test("offers approval once the session reports the Run passed", async () => {
  const { rerender } = renderReview(detailWith(verificationOf("running")));

  expect(
    await screen.findByText(/Verification Run of this draft is in progress/u)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).toBeNull();

  // The agent, not Agent View, writes the outcome. The session moving is the
  // only signal that the draft may now be approved.
  rpc.detail = detailWith(verificationOf("passed", "Everything matched."));
  rerender(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken="2026-09-02T00:00:05.000Z"
        revisionId={"rev-1"}
      />
    </TestRegistry>
  );

  expect(await screen.findByText("flow approval")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
});

test("offers nothing more once the revision is the Approved Agent Flow", async () => {
  renderReview(
    detailWith(verificationOf("passed", "Both Agent Steps worked."), {
      status: "approved",
    })
  );

  expect(
    await screen.findByText(/This revision is the Approved Agent Flow\./u)
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Authorize Verification Run" })
  ).toBeNull();
});
