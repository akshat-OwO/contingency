import { setTimeout as delay } from "node:timers/promises";

import { RegistryProvider } from "@effect/atom-react";
import {
  act,
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
  updateCalls: [] satisfies unknown[],
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
  agentFlowDraftUpdateMutation: Atom.fn(<Payload,>(payload: Payload) =>
    Effect.suspend(() => {
      rpc.updateCalls.push(payload);
      return answer();
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
  agentVariableSupplyMutation: Atom.fn(() => Effect.succeed({})),
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
      draftRevisionId: "rev-1",
      id: "flow-shop",
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
  authorizationId: "auth-1",
  authorizedAt: at,
  completedAt: status === "passed" || status === "failed" ? at : null,
  revisionId,
  sessionId: status === "authorized" ? null : "agent-verify",
  startedAt: status === "authorized" ? null : at,
  status,
  summary,
});

const renderReview = <Detail,>(
  detail: Detail,
  sessionId?: string,
  refreshToken = at
) => {
  rpc.detail = detail;
  return render(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken={refreshToken}
        revisionId={"rev-1"}
        sessionId={sessionId}
        startingPageSessionId={sessionId}
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
  rpc.updateCalls = [];
  rpc.writeError = undefined;
});

test("shows the Agent Steps, evidence, Variables, Domain Scope, and Emulation", async () => {
  renderReview(detailWith(null), "agent-one");

  expect(await screen.findByDisplayValue("Sign in")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Place the order")).toBeInTheDocument();
  expect(
    screen.getByRole("checkbox", {
      name: /Agent Step 1 Confirmation Step/u,
    })
  ).not.toBeChecked();
  expect(screen.getByLabelText("Domain Scope")).toHaveValue("shop.example.com");
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
  renderReview(detailWith(null), "agent-one");

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
  renderReview(detailWith(null), "agent-one");

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
        sessionId={"agent-one"}
        startingPageSessionId={"agent-one"}
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
        sessionId={"agent-two"}
        startingPageSessionId={"agent-two"}
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
  renderReview(detailWith(null), "agent-one");

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

test("renames a Step, edits Domain Scope, and saves one corrected proposal", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  const name = await screen.findByLabelText("Agent Step 1 name");
  await user.clear(name);
  await user.type(name, "Sign in as the demo shopper");
  const hosts = screen.getByLabelText("Domain Scope");
  await user.clear(hosts);
  await user.type(hosts, "shop.example.com{enter}*.cdn.example.com");
  await user.click(screen.getByRole("button", { name: "Save corrections" }));

  await waitFor(() => {
    expect(rpc.updateCalls).toHaveLength(1);
  });
  const [call] = rpc.updateCalls;
  const { draft, basedOnRevisionId } = call.payload.data;
  expect(basedOnRevisionId).toBe("rev-1");
  expect(draft.steps[0]?.name).toBe("Sign in as the demo shopper");
  expect(draft.domainScope.hosts).toEqual([
    "shop.example.com",
    "*.cdn.example.com",
  ]);
});

test("merges two Agent Steps into one demonstrated span", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  await user.click(
    await screen.findByRole("button", { name: "Merge with next Step" })
  );
  await user.click(screen.getByRole("button", { name: "Save corrections" }));

  await waitFor(() => {
    expect(rpc.updateCalls).toHaveLength(1);
  });
  const [call] = rpc.updateCalls;
  expect(call.payload.data.draft.steps).toHaveLength(1);
  expect(call.payload.data.draft.steps[0]).toMatchObject({
    firstActionId: "action-1",
    lastActionId: "action-3",
  });
});

test("splits one Agent Step at a demonstrated action", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  await user.selectOptions(
    await screen.findByLabelText("Split Agent Step 1 before"),
    "action-2"
  );
  const [split] = screen.getAllByRole("button", { name: "Split Step" });
  if (split === undefined) {
    throw new Error("Agent View offered no way to split an Agent Step.");
  }
  await user.click(split);
  await user.click(screen.getByRole("button", { name: "Save corrections" }));

  await waitFor(() => {
    expect(rpc.updateCalls).toHaveLength(1);
  });
  const [call] = rpc.updateCalls;
  const { steps } = call.payload.data.draft;
  expect(steps).toHaveLength(3);
  expect(steps[0]).toMatchObject({
    firstActionId: "action-1",
    lastActionId: "action-1",
  });
  expect(steps[1]).toMatchObject({
    firstActionId: "action-2",
    lastActionId: "action-2",
  });
});

test("authorizes one Verification Run for the exact draft revision", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  await user.click(
    await screen.findByRole("button", { name: "Authorize Verification Run" })
  );

  await waitFor(() => {
    expect(rpc.authorizeCalls).toHaveLength(1);
  });
  const [call] = rpc.authorizeCalls;
  expect(call.payload.data).toMatchObject({
    agentFlowId: "flow-shop",
    revisionId: "rev-1",
    // The Run opens where the authorizing session stands (issue #139).
    sessionId: "agent-one",
  });
});

test("retries verification from the page the Verification Run is showing", async () => {
  const user = userEvent.setup();
  rpc.detail = detailWith(verificationOf("failed", "The basket stayed empty."));
  render(
    <RegistryProvider>
      <DraftReview
        agentFlowId={"flow-shop" as never}
        refreshToken={at}
        revisionId={"rev-1" as never}
        // The Verification Run panel owns no Demonstration to correct, but the
        // retry must still open where that Run stands, not on `about:blank`.
        sessionId={undefined as never}
        startingPageSessionId={"agent-verify" as never}
      />
    </RegistryProvider>
  );

  await user.click(
    await screen.findByRole("button", { name: "Authorize Verification Run" })
  );

  await waitFor(() => {
    expect(rpc.authorizeCalls).toHaveLength(1);
  });
  const [retry] = rpc.authorizeCalls as [
    { readonly payload: { readonly data: { readonly sessionId: string } } },
  ];
  expect(retry.payload.data.sessionId).toBe("agent-verify");
});

test("withholds authorization until unsaved corrections are saved", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  const name = await screen.findByLabelText("Agent Step 1 name");
  await user.type(name, " again");

  expect(
    screen.queryByRole("button", { name: "Authorize Verification Run" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(/Every changed draft needs its own verification/u)
  ).toBeInTheDocument();
});

test("offers no approval until a Verification Run has passed", async () => {
  renderReview(detailWith(verificationOf("authorized")), "agent-one");

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
  expect(
    screen.getByRole("button", { name: "Authorize Verification Run" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
});

test("approves the exact revision a Verification Run proved", async () => {
  const user = userEvent.setup();
  renderReview(
    detailWith(verificationOf("passed", "Both Agent Steps worked.")),
    "agent-one"
  );

  await user.click(
    await screen.findByRole("button", { name: "Approve Agent Flow" })
  );

  await waitFor(() => {
    expect(rpc.approveCalls).toHaveLength(1);
  });
  const [call] = rpc.approveCalls;
  expect(call.payload.data.revisionId).toBe("rev-1");
});

test("treats an authorization for another revision as no authorization", async () => {
  renderReview(
    detailWith(verificationOf("passed", "It worked.", "rev-previous")),
    "agent-one"
  );

  expect(
    await screen.findByRole("button", { name: "Authorize Verification Run" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Approve Agent Flow" })
  ).not.toBeInTheDocument();
});

test("shows why a refused gesture did not take effect", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");
  rpc.writeError = "Agent Flow flow-shop draft head is rev-2, not rev-1.";

  await user.click(
    await screen.findByRole("button", { name: "Authorize Verification Run" })
  );

  expect(
    await screen.findByText(/draft head is rev-2, not rev-1\./u)
  ).toBeInTheDocument();
});

test("offers no corrections without the Teaching session behind the draft", async () => {
  renderReview(detailWith(null));

  expect(
    await screen.findByRole("button", { name: "Authorize Verification Run" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save corrections" })
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Domain Scope")).toBeDisabled();
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
        sessionId={undefined}
        startingPageSessionId={undefined}
      />
    </TestRegistry>
  );

  expect(
    await screen.findByRole("button", { name: "Approve Agent Flow" })
  ).toBeInTheDocument();
});

test("keeps unsaved corrections when the draft is reread", async () => {
  const user = userEvent.setup();
  const { rerender } = renderReview(detailWith(null), "agent-one");

  const name = await screen.findByLabelText("Agent Step 1 name");
  await user.clear(name);
  await user.type(name, "Sign in as the demo shopper");
  rerender(
    <TestRegistry>
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken="2026-09-02T00:00:05.000Z"
        revisionId={"rev-1"}
        sessionId={"agent-one"}
        startingPageSessionId={"agent-one"}
      />
    </TestRegistry>
  );

  await waitFor(() => {
    expect(screen.getByLabelText("Agent Step 1 name")).toHaveValue(
      "Sign in as the demo shopper"
    );
  });
});

test("offers the merged span's later actions as split points", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  await user.click(
    await screen.findByRole("button", { name: "Merge with next Step" })
  );

  // The merged objective covers both demonstrated Steps, so the user can split
  // it anywhere after its first action — including inside what was Step 2.
  const split = screen.getByLabelText("Split Agent Step 1 before");
  expect(
    within(split).getByRole("option", { name: "Enter Variable PASSWORD in e3" })
  ).toBeInTheDocument();
  expect(
    within(split).getByRole("option", { name: "Click Place order" })
  ).toBeInTheDocument();
});

test("shows each split Step the actions its own span covers", async () => {
  const user = userEvent.setup();
  renderReview(detailWith(null), "agent-one");

  await user.selectOptions(
    await screen.findByLabelText("Split Agent Step 1 before"),
    "action-2"
  );
  const [split] = screen.getAllByRole("button", { name: "Split Step" });
  if (split === undefined) {
    throw new Error("Agent View offered no way to split an Agent Step.");
  }
  await user.click(split);

  expect(
    screen.getByRole("list", { name: "Agent Step 1 evidence" })
  ).toHaveTextContent("Navigate to the sign-in page");
  const second = screen.getByRole("list", { name: "Agent Step 2 evidence" });
  expect(second).toHaveTextContent("Enter Variable PASSWORD in e3");
  expect(second).not.toHaveTextContent("Click Place order");
  expect(
    screen.getByRole("list", { name: "Agent Step 3 evidence" })
  ).toHaveTextContent("Click Place order");
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

/**
 * The sidebar renders each region behind a gate on the session snapshot, so an
 * update that momentarily omits the draft takes the review off screen. The
 * registry collects an idle atom shortly after its last subscriber goes, so
 * these tests let that window elapse: a synchronous assertion passes even with
 * the state discarded.
 */
const IDLE_WINDOW = 700;

const GatedReview = ({ shown }: { readonly shown: boolean }) => (
  <TestRegistry>
    {shown ? (
      <DraftReview
        agentFlowId={"flow-shop"}
        refreshToken={at}
        revisionId={"rev-1"}
        sessionId={"agent-one"}
        startingPageSessionId={"agent-one"}
      />
    ) : (
      <p>The draft is not on screen.</p>
    )}
  </TestRegistry>
);

const leaveAndReturn = async (
  rerender: (ui: React.ReactElement) => void
): Promise<void> => {
  rerender(<GatedReview shown={false} />);
  await act(async () => {
    await delay(IDLE_WINDOW);
  });
  rerender(<GatedReview shown={true} />);
  await screen.findByLabelText("Agent Step 1 name");
};

test("keeps a renamed Step when the review leaves the screen and returns", async () => {
  const user = userEvent.setup();
  rpc.detail = detailWith(null);
  const { rerender } = render(<GatedReview shown={true} />);

  const name = await screen.findByLabelText("Agent Step 1 name");
  await user.clear(name);
  await user.type(name, "Sign in as the demo shopper");
  await leaveAndReturn(rerender);

  expect(screen.getByLabelText("Agent Step 1 name")).toHaveValue(
    "Sign in as the demo shopper"
  );
  expect(
    screen.getByRole("button", { name: "Save corrections" })
  ).toBeEnabled();
});

test("keeps a Confirmation Step marker when the review leaves the screen and returns", async () => {
  const user = userEvent.setup();
  rpc.detail = detailWith(null);
  const { rerender } = render(<GatedReview shown={true} />);

  const marker = await screen.findByRole("checkbox", {
    name: /Agent Step 1 Confirmation Step/u,
  });
  await user.click(marker);
  await leaveAndReturn(rerender);

  expect(
    screen.getByRole("checkbox", { name: /Agent Step 1 Confirmation Step/u })
  ).toBeChecked();
});

test("keeps typed Domain Scope, including a line with no host yet", async () => {
  const user = userEvent.setup();
  rpc.detail = detailWith(null);
  const { rerender } = render(<GatedReview shown={true} />);

  const hosts = await screen.findByLabelText("Domain Scope");
  await user.clear(hosts);
  await user.type(hosts, "shop.example.com\npay.example.com\n");
  await leaveAndReturn(rerender);

  expect(screen.getByLabelText("Domain Scope")).toHaveValue(
    "shop.example.com\npay.example.com\n"
  );
});
