import {
  AgentRunId,
  CatalogRootView,
  CatalogRunEntry,
} from "@contingency/protocol";
import type {
  CatalogBrowseResult,
  CatalogFlowResult,
} from "@contingency/protocol";
import {
  RegistryProvider,
  useAtomInitialValues,
  useAtomRefresh,
} from "@effect/atom-react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Cause, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { FlowMarkdown } from "@/components/catalog/flow-markdown";
import { markdownBlocks } from "@/components/catalog/flow-markdown-blocks";
import { FlowsPage } from "@/components/catalog/flows-page";
import type {
  FlowsFolder,
  FlowsSessionView,
} from "@/components/catalog/flows-page-state";
import {
  availableFolder,
  defaultFolder,
  flowsOriginAtom,
  folderFromParam,
  folderOfRun,
  folderParam,
  looseRuns,
  orphanRecordings,
  rootHistoryCount,
  sessionFlows,
  showsGlobalAtFirst,
} from "@/components/catalog/flows-page-state";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { routeTree } from "@/routeTree.gen";

afterEach(() => {
  cleanup();
});

const rpc = vi.hoisted(() => ({
  browse: { _tag: "Initial", waiting: true } satisfies unknown,
  flow: { _tag: "Initial", waiting: true } satisfies unknown,
  summary: { _tag: "Initial", waiting: true } satisfies unknown,
}));

const rpcOverrides = {
  agentRunSummaryAtom: () => Atom.make(() => rpc.summary),
  catalogBrowseAtom: Atom.make(() => rpc.browse),
  catalogFlowAtom: () => () => Atom.make(() => rpc.flow),
};

/** The page with its URL state held here, as the `/flow` route holds it. */
const Page = ({
  initial,
  origin,
  run: initialRun,
}: {
  readonly initial?: FlowsFolder;
  readonly origin?: FlowsSessionView;
  readonly run?: AgentRunId;
}) => {
  useAtomInitialValues([[flowsOriginAtom, origin ?? null]]);
  const [flow, setFlow] = useState(initial);
  const [run, setRun] = useState(initialRun);
  return (
    <>
      <output data-testid="url">
        {flow === undefined ? "" : folderParam(flow)}|{run ?? ""}
      </output>
      <FlowsPage
        flow={flow}
        onNavigate={(next) => {
          setFlow(next.flow);
          setRun(next.run);
        }}
        run={run}
      />
    </>
  );
};

const renderPage = (
  props: Parameters<typeof Page>[0] = {}
): ReturnType<typeof render> =>
  render(
    <RpcDependenciesProvider overrides={rpcOverrides}>
      <RegistryProvider>
        <Page {...props} />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );

const url = () => screen.getByTestId("url").textContent;

const runId = Schema.decodeUnknownSync(AgentRunId);

const run = {
  assessment: "working",
  endedAt: "2026-10-04T16:16:40.000Z",
  flowNames: ["1mg mobile login"],
  kind: "interactive",
  outcome: "completed",
  recordingId: null,
  runId: "agentrun-login",
  startedAt: "2026-10-04T16:13:28.000Z",
  title: "Sign in with a fresh SMS code",
} as const;

type RootFixture = Omit<CatalogRootView, "flows" | "runs" | "recordings"> & {
  flows: readonly (Omit<CatalogRootView["flows"][number], "groupPath"> & {
    groupPath?: readonly string[];
  })[];
  runs: readonly (Omit<CatalogRootView["runs"][number], "ownerFlow"> & {
    ownerFlow?: string | null;
  })[];
  recordings: readonly (Omit<
    CatalogRootView["recordings"][number],
    "ownerFlow"
  > & { ownerFlow?: string })[];
};
const decodeRoot = (value: RootFixture) =>
  Schema.decodeUnknownSync(CatalogRootView)({
    ...value,
    flows: value.flows.map((flow) => ({ groupPath: [], ...flow })),
    recordings: value.recordings.map((entry) => ({
      ownerFlow: entry.flowName,
      ...entry,
    })),
    runs: value.runs.map((entry) => ({
      ownerFlow:
        entry.flowNames.find((name) =>
          value.flows.some((flow) => flow.name === name)
        ) ?? null,
      ...entry,
    })),
  });

const local = decodeRoot({
  flows: [
    {
      description: "Sign in to 1mg mobile web.",
      hosts: ["www.1mg.com"],
      name: "1mg mobile login",
      stepCount: 4,
      verified: true,
    },
    {
      description: "Fill a cart for Boulder.",
      hosts: ["ridgeline.localhost"],
      name: "Ridgeline Boulder cart",
      stepCount: 4,
      verified: false,
    },
  ],
  path: "/project/.contingency",
  present: true,
  recordings: [],
  runs: [
    run,
    {
      ...run,
      assessment: null,
      flowNames: [],
      runId: "agentrun-loose",
      title: "Explore the store",
    },
  ],
  scope: "local",
  unreadable: 0,
});

const global = decodeRoot({
  flows: [
    {
      description: "Sign in to staging.",
      hosts: ["sso.example.com"],
      name: "Staging SSO login",
      stepCount: 2,
      verified: true,
    },
  ],
  path: "/home/me/.contingency",
  present: true,
  recordings: [],
  runs: [],
  scope: "global",
  unreadable: 0,
});

const emptyLocal = decodeRoot({
  ...local,
  flows: [],
  present: false,
  runs: [],
});

const browse = (roots: readonly CatalogRootView[]) => ({
  _tag: "Success" as const,
  value: { roots } satisfies CatalogBrowseResult,
  waiting: false,
});

const teaching = (captureState: string) =>
  ({ activity: "teaching", captureState, flowName: "cart" }) as const;

const recording = {
  cleanup: "pending",
  createdAt: "2026-10-04T16:13:28.000Z",
  flowName: "1mg mobile login",
  keyframeCount: 2,
  ownerFlow: "1mg mobile login",
  phase: "flow-drafted",
  recordingId: "recording-retained",
} as const;

const retained = decodeRoot({
  ...local,
  flows: [],
  recordings: [recording],
  runs: local.runs.map((entry) => ({ ...entry, ownerFlow: null })),
});

const RefreshCatalog = () => {
  const refresh = useAtomRefresh(rpcOverrides.catalogBrowseAtom);
  return (
    <button onClick={refresh} type="button">
      Refresh catalog
    </button>
  );
};

const flowResult = (files: CatalogFlowResult["files"]) =>
  ({
    _tag: "Success",
    value: { entry: local.flows[0], files, steps: [] },
    waiting: false,
  }) as const;

test("reads a Flow folder from `?flow=` and writes it back", () => {
  const cases: [string, FlowsFolder][] = [
    ["checkout", { kind: "flow", name: "checkout", scope: "local" }],
    ["@root", { kind: "root", scope: "local" }],
    ["global:sso", { kind: "flow", name: "sso", scope: "global" }],
    ["global:@root", { kind: "root", scope: "global" }],
  ];
  for (const [param, folder] of cases) {
    expect(folderFromParam(param)).toEqual(folder);
    expect(folderParam(folder)).toBe(param);
  }
  expect(folderFromParam()).toBeUndefined();
  expect(folderFromParam("global:")).toBeUndefined();
});

test("opens on the session's Flow, then local-first", () => {
  const none = sessionFlows();
  expect(defaultFolder([local, global], none)).toEqual({
    kind: "flow",
    name: "1mg mobile login",
    scope: "local",
  });
  expect(defaultFolder([retained, global], none)).toEqual({
    kind: "root",
    scope: "local",
  });
  expect(defaultFolder([emptyLocal, global], none)).toEqual({
    kind: "flow",
    name: "Staging SSO login",
    scope: "global",
  });
  expect(
    defaultFolder([retained, global], sessionFlows(teaching("recording")))
  ).toEqual({ kind: "flow", name: "cart", scope: "local" });
  expect(
    defaultFolder(
      [local, global],
      sessionFlows({
        activity: "run",
        dryRun: false,
        flowNames: ["Staging SSO login"],
      })
    )
  ).toEqual({ kind: "flow", name: "Staging SSO login", scope: "global" });
});

test("marks the session's own Flow by where it stands", () => {
  expect(sessionFlows(teaching("recording"))).toEqual({
    labels: new Map(),
    pending: "cart",
  });
  expect(sessionFlows(teaching("verified")).labels.get("cart")).toBe(
    "This session"
  );
  expect(
    sessionFlows({ activity: "run", dryRun: true, flowNames: ["a"] }).labels
  ).toEqual(new Map([["a", "This session"]]));
});

test("files Runs and recordings under their Flow or the root's history", () => {
  expect(looseRuns(local).map((entry) => entry.runId)).toEqual([
    "agentrun-loose",
  ]);
  expect(
    orphanRecordings(decodeRoot({ ...local, recordings: [recording] }))
  ).toEqual([]);
  expect(orphanRecordings(retained)).toEqual([recording]);
  // A Flow still being taught keeps its recordings under its placeholder.
  expect(orphanRecordings(retained, "1mg mobile login")).toEqual([]);
  expect(rootHistoryCount(retained)).toBe(3);
  expect(folderOfRun([local, global], runId("agentrun-login"))).toEqual({
    kind: "flow",
    name: "1mg mobile login",
    scope: "local",
  });
  expect(folderOfRun([local], runId("agentrun-loose"))).toEqual({
    kind: "root",
    scope: "local",
  });
  expect(
    availableFolder(
      { kind: "flow", name: "gone", scope: "local" },
      [local],
      sessionFlows()
    )
  ).toBeUndefined();
});

test("shows the user-global root at first only when it is all there is", () => {
  expect(showsGlobalAtFirst([local, global])).toBe(false);
  expect(
    showsGlobalAtFirst([local, global], {
      kind: "flow",
      name: "Staging SSO login",
      scope: "global",
    })
  ).toBe(true);
  expect(showsGlobalAtFirst([emptyLocal, global])).toBe(true);
});

test("lists local Flows, hides Global behind its filter, and shows a Flow's Runs", async () => {
  rpc.browse = browse([local, global]);
  rpc.flow = { _tag: "Initial", waiting: true };
  renderPage();
  const catalog = screen.getByRole("complementary", { name: "Catalog" });
  const tree = within(catalog).getByRole("tree", { name: "Local Flows" });
  expect(
    within(tree).getByRole("treeitem", { name: /1mg mobile login/u })
  ).toHaveAttribute("aria-selected", "true");
  expect(url()).toBe("1mg mobile login|");
  expect(
    within(catalog).queryByRole("tree", { name: "Global Flows" })
  ).toBeNull();
  const runs = screen.getByRole("region", { name: "Runs" });
  expect(
    within(runs).getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toHaveAttribute("aria-pressed", "true");

  const filter = within(catalog).getByRole("button", { name: "Global" });
  await userEvent.click(filter);
  expect(filter).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(
    within(
      within(catalog).getByRole("tree", { name: "Global Flows" })
    ).getByRole("treeitem", { name: /Staging SSO login/u })
  );
  expect(url()).toBe("global:Staging SSO login|");
  expect(
    screen.getByRole("region", { name: "Staging SSO login" })
  ).toBeVisible();

  await userEvent.click(
    within(catalog).getByRole("button", { name: /Runs without one Flow/u })
  );
  expect(url()).toBe("@root|");
  expect(
    within(screen.getByRole("region", { name: "Runs" })).getByRole("button", {
      name: /Explore the store/u,
    })
  ).toBeVisible();
});

test("says what to do next for a drafted Flow with no Runs", async () => {
  rpc.browse = browse([local]);
  renderPage();
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  expect(
    screen.getByText("No Runs yet. Ask your agent to Dry Run this Flow.")
  ).toBeVisible();
});

test("keeps nested Groups open and navigable by keyboard", async () => {
  rpc.browse = browse([
    decodeRoot({
      ...local,
      flows: local.flows.map((flow) => ({
        ...flow,
        groupPath: ["Commerce", "Checkout"],
      })),
    }),
  ]);
  renderPage();
  const commerce = screen.getByRole("treeitem", { name: /^Commerce/u });
  expect(commerce).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("treeitem", { name: /^Checkout/u })).toBeVisible();
  commerce.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(commerce).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("treeitem", { name: /^Checkout/u })).toBeNull();
});

test("holds a place for the Flow the session is teaching", () => {
  rpc.browse = browse([local, global]);
  renderPage({ origin: teaching("recording") });
  expect(
    screen.getByRole("button", { name: /^cart\s*Being taught$/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(url()).toBe("cart|");
  expect(screen.getByText(/drafts/u)).toHaveTextContent("cart/flow.md");
});

test("tags a saved session Flow This session", () => {
  rpc.browse = browse([local, global]);
  renderPage({
    origin: { activity: "run", dryRun: false, flowNames: ["1mg mobile login"] },
  });
  expect(
    screen.getByRole("treeitem", { name: /1mg mobile login\s*This session/u })
  ).toHaveAttribute("aria-selected", "true");
});

test("opens a Run named only by `?run=` under its Flow", () => {
  rpc.browse = browse([local, global]);
  renderPage({ run: runId("agentrun-loose") });
  expect(url()).toBe("@root|agentrun-loose");
  expect(
    screen.getByRole("button", { name: /Explore the store/u })
  ).toHaveAttribute("aria-pressed", "true");
});

test("says a named Run is missing rather than showing another", () => {
  rpc.browse = browse([local, global]);
  renderPage({ run: runId("agentrun-missing") });
  // The page still opens on a folder, but shows no other Run's report.
  expect(url()).toBe("1mg mobile login|agentrun-missing");
  expect(screen.getByRole("alert")).toHaveTextContent(
    /This Run is not listed here.*agentrun-missing/u
  );
  expect(screen.queryByRole("region", { name: "Run Summary" })).toBeNull();
  for (const entry of within(
    screen.getByRole("list", { name: "Runs and recordings" })
  ).getAllByRole("button")) {
    expect(entry).toHaveAttribute("aria-pressed", "false");
  }
});

test("says a Run named under another folder is not listed there", () => {
  rpc.browse = browse([local, global]);
  renderPage({
    initial: { kind: "flow", name: "1mg mobile login", scope: "local" },
    run: runId("agentrun-loose"),
  });
  expect(url()).toBe("1mg mobile login|agentrun-loose");
  expect(screen.getByRole("alert")).toHaveTextContent(/agentrun-loose/u);
  expect(screen.queryByRole("region", { name: "Run Summary" })).toBeNull();
});

test("shows a Run's catalog summary when its full Summary cannot be read", () => {
  rpc.browse = browse([
    decodeRoot({
      ...local,
      runs: [
        {
          ...run,
          explanation: "Signed in with the SMS code.",
          findings: [
            {
              explanation: "The resend link stayed disabled.",
              id: "finding-1",
              outcome: "not-working",
            },
          ],
        },
      ],
    }),
  ]);
  rpc.summary = {
    _tag: "Failure",
    cause: Cause.fail(new Error("gone")),
    waiting: false,
  };
  renderPage();
  const summary = screen.getByRole("region", { name: "Run Summary" });
  expect(
    within(summary).getByText("Signed in with the SMS code.")
  ).toBeVisible();
  const findings = within(summary).getByRole("region", { name: "Findings" });
  expect(within(findings).getByText("1 finding")).toBeVisible();
  expect(within(findings).getByText("Not working")).toBeVisible();
  expect(
    within(summary).getByText(/Its full Run Summary could not be read/u)
  ).toBeVisible();
});

test("points a native Run at its device session for its video", () => {
  const sessionId = `agent-android-${"d".repeat(32)}`;
  rpc.browse = browse([
    decodeRoot({
      ...local,
      runs: [
        Schema.decodeUnknownSync(CatalogRunEntry)({
          ...run,
          assessment: null,
          kind: "dry-run",
          native: { platform: "android", sessionId },
          outcome: "user-closed",
          ownerFlow: "1mg mobile login",
          runId: `agentrun-${sessionId}`,
          title: "Android Dry Run · 1mg mobile login",
        }),
      ],
    }),
  ]);
  renderPage();
  const summary = screen.getByRole("region", { name: "Run Summary" });
  expect(
    within(summary).getByRole("heading", {
      name: "Android Dry Run · 1mg mobile login",
    })
  ).toBeVisible();
  expect(
    within(summary).getByRole("link", { name: "device session" })
  ).toHaveAttribute("href", `/?android=${sessionId}`);
});

test("says a global Run's evidence stays with its own root", () => {
  rpc.browse = browse([
    emptyLocal,
    decodeRoot({
      ...global,
      runs: [{ ...run, flowNames: ["Staging SSO login"], runId: "agentrun-g" }],
    }),
  ]);
  renderPage();
  expect(url()).toBe("global:Staging SSO login|");
  expect(
    screen.getByText(/This Run is stored in ~\/.contingency/u)
  ).toBeVisible();
});

test("says so when neither root has a Flow", () => {
  rpc.browse = browse([emptyLocal, decodeRoot({ ...global, flows: [] })]);
  renderPage();
  expect(screen.getByRole("heading", { name: "No Flows yet" })).toBeVisible();
  expect(screen.queryByRole("complementary", { name: "Catalog" })).toBeNull();
});

test("warns about unreadable documents beside a healthy catalog", () => {
  rpc.browse = browse([decodeRoot({ ...local, unreadable: 1 }), global]);
  renderPage();
  expect(
    screen.getByText("1 catalog document could not be read.")
  ).toBeVisible();
  cleanup();
  rpc.browse = browse([
    decodeRoot({ ...emptyLocal, present: true, unreadable: 1 }),
    decodeRoot({ ...global, flows: [], unreadable: 2 }),
  ]);
  renderPage();
  expect(
    screen.getByText("3 catalog documents could not be read.")
  ).toBeVisible();
  cleanup();
  rpc.browse = browse([local, global]);
  renderPage();
  expect(
    screen.queryByText(/catalog documents? could not be read/u)
  ).toBeNull();
});

test("reports a catalog that cannot be read", () => {
  rpc.browse = {
    _tag: "Failure",
    cause: Cause.fail(new Error("no root")),
    waiting: false,
  };
  renderPage();
  expect(screen.getByText("The catalog could not be read")).toBeVisible();
});

test("refresh drops a removed Flow for the next one", async () => {
  rpc.browse = browse([local, global]);
  render(
    <RpcDependenciesProvider overrides={rpcOverrides}>
      <RegistryProvider>
        <RefreshCatalog />
        <Page
          initial={{
            kind: "flow",
            name: "Ridgeline Boulder cart",
            scope: "local",
          }}
        />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );
  expect(url()).toBe("Ridgeline Boulder cart|");
  rpc.browse = browse([
    decodeRoot({ ...local, flows: local.flows.slice(0, 1) }),
    global,
  ]);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh catalog" })
  );
  expect(url()).toBe("1mg mobile login|");
});

const FLOW_MD = `---
name: checkout
hosts:
  - shop.example.com
---

# Check out

Targets are in [targets.md](targets.md). See [the docs](https://example.com).

1. Open the **Shop** page.

   Done when: the page shows \`Products\`.

2. Pay.
   Done when: the receipt shows.

- one
- two
`;

test("renders a Flow's markdown with each step's Done when", () => {
  expect(markdownBlocks(FLOW_MD).map((block) => block.kind)).toEqual([
    "heading",
    "paragraph",
    "steps",
    "list",
  ]);
  const steps = markdownBlocks(FLOW_MD).find((block) => block.kind === "steps");
  expect(steps).toMatchObject({
    items: [
      {
        doneWhen: "the page shows `Products`.",
        text: "Open the **Shop** page.",
      },
      { doneWhen: "the receipt shows.", text: "Pay." },
    ],
    kind: "steps",
  });
});

test("a link to a package file opens its tab", async () => {
  rpc.browse = browse([local]);
  rpc.flow = flowResult([
    { content: FLOW_MD, path: "flow.md" },
    { content: "# Targets\n\n- the Pay button\n", path: "targets.md" },
  ]);
  renderPage();
  const files = screen.getByRole("tablist", { name: "Flow files" });
  expect(within(files).getByRole("tab", { name: "flow.md" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(screen.getAllByText("Done when")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
    "href",
    "https://example.com"
  );
  await userEvent.click(screen.getByRole("button", { name: "targets.md" }));
  expect(
    within(files).getByRole("tab", { name: "targets.md" })
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("the Pay button")).toBeVisible();
});

test("renders a file that is not markdown as it is written", () => {
  render(<FlowMarkdown files={[]} onFile={() => {}} source={"plain text"} />);
  expect(screen.getByText("plain text")).toBeVisible();
});

test("`/?run=<id>` lands on the Flows page with that Run selected", async () => {
  rpc.browse = browse([local, global]);
  rpc.summary = { _tag: "Initial", waiting: true };
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ["/?run=agentrun-login"],
    }),
    routeTree,
  });
  render(
    <RpcDependenciesProvider overrides={rpcOverrides}>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );
  await screen.findByRole("complementary", { name: "Catalog" });
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/flow");
    expect(router.state.location.search).toEqual({
      flow: "1mg mobile login",
      run: "agentrun-login",
    });
  });
  expect(screen.getByRole("link", { name: /^Flows/u })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("a `/?run=` link to a missing Run lands on the page and says so", async () => {
  rpc.browse = browse([local, global]);
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ["/?run=agentrun-missing"],
    }),
    routeTree,
  });
  render(
    <RpcDependenciesProvider overrides={rpcOverrides}>
      <RegistryProvider>
        <RouterProvider router={router} />
      </RegistryProvider>
    </RpcDependenciesProvider>
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /agentrun-missing/u
  );
  expect(router.state.location.search).toMatchObject({
    run: "agentrun-missing",
  });
  expect(screen.queryByRole("region", { name: "Run Summary" })).toBeNull();
});
