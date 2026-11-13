import { CatalogRootView, CatalogRunEntry } from "@contingency/protocol";
import type { CatalogBrowseResult } from "@contingency/protocol";
import {
  RegistryProvider,
  useAtomRefresh,
  useAtomValue,
} from "@effect/atom-react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { FlowDetails } from "@/components/catalog/flow-details";
import { FlowsDrawer } from "@/components/catalog/flows-drawer";
import {
  availableFolder,
  defaultFolder,
  looseRuns,
  opensGlobal,
  orphanRecordings,
  sessionFlows,
  showsFlowsEntry,
  flowsSelectionAtom,
} from "@/components/catalog/flows-drawer-state";
import { stepInstruction } from "@/components/catalog/flows-format";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

let probeWidth = 1;
const observers = new Set<() => void>();

beforeEach(() => {
  probeWidth = 1;
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      readonly notify: ResizeObserverCallback;
      readonly subscriptions = new Set<() => void>();
      constructor(notify: ResizeObserverCallback) {
        this.notify = notify;
      }
      observe(target: Element) {
        const notify = () => {
          const size = { blockSize: 1, inlineSize: probeWidth };
          this.notify(
            [
              {
                borderBoxSize: [size],
                contentBoxSize: [size],
                contentRect: new DOMRect(0, 0, probeWidth, 1),
                devicePixelContentBoxSize: [size],
                target,
              },
            ],
            this
          );
        };
        this.subscriptions.add(notify);
        observers.add(notify);
        notify();
      }
      disconnect() {
        for (const notify of this.subscriptions) {
          observers.delete(notify);
        }
        this.subscriptions.clear();
      }
      unobserve() {
        this.disconnect();
      }
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const resizeNavigation = (width: number) => {
  act(() => {
    probeWidth = width;
    for (const notify of observers) {
      notify();
    }
  });
};

const rpc = vi.hoisted(() => ({
  browse: { _tag: "Initial", waiting: true } satisfies unknown,
}));

const rpcOverrides = {
  catalogBrowseAtom: Atom.make(() => rpc.browse),
};

const TestRegistry = ({ children }: { readonly children: ReactNode }) => (
  <RpcDependenciesProvider overrides={rpcOverrides}>
    <RegistryProvider>{children}</RegistryProvider>
  </RpcDependenciesProvider>
);

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

const ObserveSelection = () => {
  useAtomValue(flowsSelectionAtom);
  return null;
};

const SelectedDetails = () => {
  const selection = useAtomValue(flowsSelectionAtom);
  return selection === null ? null : <FlowDetails selection={selection} />;
};

test("selects nonempty folders local-first after Teaching and session flows", () => {
  const none = sessionFlows();
  expect(defaultFolder([retained, global], none)).toEqual({
    kind: "loose",
    scope: "local",
  });
  const recordingOnly = decodeRoot({ ...retained, runs: [] });
  expect(defaultFolder([recordingOnly, global], none)).toEqual({
    kind: "recordings",
    scope: "local",
  });
  expect(defaultFolder([emptyLocal, global], none)).toEqual({
    kind: "flow",
    name: "Staging SSO login",
    scope: "global",
  });
  expect(
    defaultFolder([retained, global], sessionFlows(teaching("setup")))
  ).toEqual({ kind: "flow", name: "cart", scope: "local" });
  expect(
    defaultFolder(
      [retained, global],
      sessionFlows({
        activity: "run",
        dryRun: false,
        flowNames: ["Staging SSO login"],
      })
    )
  ).toEqual({ kind: "flow", name: "Staging SSO login", scope: "global" });
  expect(
    opensGlobal(
      [emptyLocal, decodeRoot({ ...retained, scope: "global" })],
      "",
      none
    )
  ).toBe(true);
  expect(opensGlobal([recordingOnly, global], "", none)).toBe(false);
});

test("groups recordings only under flows listed in their own root", () => {
  expect(
    orphanRecordings(decodeRoot({ ...local, recordings: [recording] }))
  ).toEqual([]);
  expect(orphanRecordings(retained)).toEqual([recording]);
});

test("restores retained Runs and orphan recordings when the filter clears", async () => {
  rpc.browse = browse([retained]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.queryByText("No Flows yet")).toBeNull();
  expect(screen.getByRole("button", { name: /Root Runs/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(
    screen.getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toBeVisible();
  await userEvent.type(screen.getByLabelText("Filter flows"), "missing");
  expect(
    screen.queryByRole("button", { name: /Other recordings/u })
  ).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show all flows" }));
  await userEvent.click(
    screen.getByRole("button", { name: /Other recordings/u })
  );
  expect(
    screen.getByRole("button", { name: /recording-retained/u })
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
});

test("opens global-only orphan recordings with no nonexistent flow action", async () => {
  const root = decodeRoot({ ...retained, runs: [], scope: "global" });
  rpc.browse = browse([emptyLocal, root]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
      <SelectedDetails />
    </TestRegistry>
  );
  expect(
    screen.getByRole("button", { name: /Other recordings/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByRole("button", { name: /recording-retained/u })
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /Global\s*1/u })).toBeVisible();
  expect(screen.queryByText("1mg mobile login")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: /recording-retained/u })
  );
  expect(
    screen.getByRole("heading", { name: "recording-retained" })
  ).toBeVisible();
  expect(screen.getByText("1mg mobile login")).toHaveAttribute(
    "title",
    "Not in this Catalog Root"
  );
  expect(screen.queryByRole("button", { name: "1mg mobile login" })).toBeNull();
});

test("counts Global history without double-counting listed-flow entries", async () => {
  const root = decodeRoot({
    ...local,
    recordings: [
      recording,
      {
        ...recording,
        flowName: "deleted-cart",
        ownerFlow: "deleted-cart",
        recordingId: "recording-orphan",
      },
    ],
    scope: "global",
  });
  rpc.browse = browse([emptyLocal, root]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByRole("button", { name: /Global\s*4/u })).toBeVisible();
  await userEvent.type(screen.getByLabelText("Filter flows"), "1mg");
  expect(screen.getByRole("button", { name: /Global\s*1/u })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByRole("button", { name: /Global\s*4/u })).toBeVisible();
});

test("refresh replaces a removed selected flow with retained history, then emptiness", async () => {
  rpc.browse = browse([local]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
      <RefreshCatalog />
    </TestRegistry>
  );
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  rpc.browse = browse([retained]);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh catalog" })
  );
  expect(screen.getByRole("button", { name: /Root Runs/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
  rpc.browse = browse([decodeRoot({ ...retained, runs: [] })]);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh catalog" })
  );
  expect(
    screen.getByRole("button", { name: /Other recordings/u })
  ).toHaveAttribute("aria-pressed", "true");
  rpc.browse = browse([emptyLocal]);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh catalog" })
  );
  expect(screen.getByText("No Flows yet")).toBeVisible();
  expect(
    availableFolder(
      { kind: "recordings", scope: "global" },
      [emptyLocal],
      sessionFlows()
    )
  ).toBeUndefined();
});

test("hides the Flows entry only while the journey is captured", () => {
  expect(showsFlowsEntry()).toBe(true);
  expect(showsFlowsEntry(teaching("setup"))).toBe(true);
  expect(showsFlowsEntry(teaching("recording"))).toBe(false);
  expect(showsFlowsEntry(teaching("finalizing"))).toBe(false);
  expect(showsFlowsEntry(teaching("ready"))).toBe(true);
  expect(
    showsFlowsEntry({ activity: "run", dryRun: false, flowNames: [] })
  ).toBe(true);
});

test("marks the session's own flow by where it stands", () => {
  expect(
    sessionFlows({
      activity: "teaching",
      captureState: "setup",
      flowName: "cart",
    })
  ).toEqual({ labels: new Map(), pending: "cart" });
  expect(
    sessionFlows({
      activity: "teaching",
      captureState: "flow-drafted",
      flowName: "cart",
    }).labels.get("cart")
  ).toBe("This session");
  expect(
    sessionFlows({
      activity: "run",
      dryRun: true,
      flowNames: ["cart"],
    }).labels.get("cart")
  ).toBe("This Dry Run");
  expect([
    ...sessionFlows({
      activity: "run",
      dryRun: false,
      flowNames: ["login", "cart"],
    }).labels.entries(),
  ]).toEqual([
    ["login", "In this run"],
    ["cart", "In this run"],
  ]);
});

test("opens on the session's flow, then on the first local flow", () => {
  const none = sessionFlows();
  expect(defaultFolder([local, global], none)).toEqual({
    kind: "flow",
    name: "1mg mobile login",
    scope: "local",
  });
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
  expect(defaultFolder([emptyLocal], none)).toBeUndefined();
});

test("unfolds Global only when it is the one place with a match", () => {
  const none = sessionFlows();
  expect(opensGlobal([local, global], "", none)).toBe(false);
  expect(opensGlobal([emptyLocal, global], "", none)).toBe(true);
  expect(opensGlobal([local, global], "staging", none)).toBe(true);
  expect(opensGlobal([local, global], "nothing", none)).toBe(false);
});

test("lists local flows, folds Global, and opens a flow's Runs", async () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  const catalog = screen.getByRole("region", { name: "Catalog" });
  expect(
    within(catalog).getByRole("treeitem", { name: /1mg mobile login/u })
  ).toHaveAttribute("aria-selected", "true");
  expect(
    within(catalog).getByRole("treeitem", { name: /Verified · 1 run/u })
  ).toBeInTheDocument();
  expect(within(catalog).queryByText("Staging SSO login")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toBeInTheDocument();

  await userEvent.click(
    within(catalog).getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  expect(screen.getByText(/A passing Dry Run is the next step/u)).toBeVisible();

  await userEvent.click(
    within(catalog).getByRole("button", { name: /Root Runs/u })
  );
  expect(
    screen.getByRole("button", { name: /Explore the store/u })
  ).toBeInTheDocument();
});

test("holds a place for a flow still being taught", () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <FlowsDrawer
        session={{
          activity: "teaching",
          captureState: "setup",
          flowName: "New cart",
        }}
      />
    </TestRegistry>
  );
  expect(
    screen.getByRole("button", { name: /New cart.*Being taught/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Not saved yet")).toBeVisible();
});

test("says so when neither root has a flow", () => {
  rpc.browse = browse([emptyLocal, decodeRoot({ ...global, flows: [] })]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByText("No Flows yet")).toBeVisible();
});

test("names the miss and offers every flow again", async () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  await userEvent.type(screen.getByLabelText("Filter flows"), "checkout");
  expect(screen.getByText("No flow matches “checkout”")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show all flows" }));
  expect(screen.getByLabelText("Filter flows")).toHaveValue("");
});

test("files a Run under Root Runs when no listed flow claims it", () => {
  const example = { ...run, flowNames: ["example-delivery-cart"] };
  const root = decodeRoot({ ...local, runs: [run, example] });
  expect(looseRuns(root).map((entry) => entry.runId)).toEqual([example.runId]);
});

test("reads a step as one instruction without its number or outcome", () => {
  expect(
    stepInstruction(
      "2. Choose `{{city}}` in City, then click **Save location**.\n   Done when: the status reads the city."
    )
  ).toBe("Choose `{{city}}` in City, then click Save location.");
});

test("shows a nonfatal singular warning alongside healthy entries", async () => {
  rpc.browse = browse([decodeRoot({ ...local, unreadable: 1 }), global]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 catalog document could not be read."
  );
  expect(screen.queryByText("The catalog could not be read")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  expect(screen.getByText(/A passing Dry Run is the next step/u)).toBeVisible();
});

test("shows the combined plural warning with the empty state", () => {
  rpc.browse = browse([
    decodeRoot({ ...emptyLocal, present: true, unreadable: 1 }),
    decodeRoot({ ...global, flows: [], unreadable: 2 }),
  ]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "3 catalog documents could not be read."
  );
  expect(screen.getByText("No Flows yet")).toBeVisible();
  expect(screen.queryByText("The catalog could not be read")).toBeNull();
});

test("omits the unreadable warning for a healthy catalog", () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.queryByRole("status")).toBeNull();
});

test("narrow navigation preserves filter, folder, Details selection and keyboard focus", async () => {
  probeWidth = 0;
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
      <ObserveSelection />
    </TestRegistry>
  );
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
  await userEvent.type(screen.getByLabelText("Filter flows"), "1mg");
  const row = screen.getByRole("treeitem", { name: /1mg mobile login/u });
  row.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.queryByRole("region", { name: "Catalog" })).toBeNull();
  expect(
    screen.getByRole("heading", { name: "1mg mobile login" })
  ).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "flow.md" }));
  expect(screen.getByRole("button", { name: "flow.md" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Back to catalog" })
  );
  expect(screen.getByLabelText("Filter flows")).toHaveValue("1mg");
  expect(
    screen.getByRole("treeitem", { name: /1mg mobile login/u })
  ).toHaveFocus();
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "flow.md" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("resizing keeps the focused navigation view and selected folder usable", async () => {
  rpc.browse = browse([local]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
      <ObserveSelection />
    </TestRegistry>
  );
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  resizeNavigation(0);
  expect(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  ).toHaveFocus();
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
  await userEvent.keyboard("{Enter}");
  resizeNavigation(1);
  expect(
    screen.getByRole("heading", { name: "Ridgeline Boulder cart" })
  ).toHaveFocus();
  resizeNavigation(0);
  expect(
    screen.getByRole("heading", { name: "Ridgeline Boulder cart" })
  ).toHaveFocus();
  expect(screen.queryByRole("region", { name: "Catalog" })).toBeNull();
});

test("narrow no-match recovery retains the chosen folder and restores history", async () => {
  probeWidth = 0;
  rpc.browse = browse([
    decodeRoot({
      ...local,
      recordings: [
        recording,
        {
          ...recording,
          flowName: "deleted-cart",
          ownerFlow: "deleted-cart",
          recordingId: "recording-orphan",
        },
      ],
    }),
    global,
  ]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Back to catalog" })
  );
  await userEvent.type(screen.getByLabelText("Filter flows"), "nothing");
  expect(screen.getByText("Nothing here matches “nothing”.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show all flows" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Root Runs/u })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Other recordings/u })
  ).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByLabelText("Filter flows")).toHaveValue("");
  expect(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: /Root Runs/u })).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Other recordings/u })
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "flow.md" })).toBeNull();
  await userEvent.click(
    screen.getByRole("treeitem", { name: /Ridgeline Boulder cart/u })
  );
  expect(
    screen.getByRole("heading", { name: "Ridgeline Boulder cart" })
  ).toHaveFocus();
  expect(screen.getByRole("button", { name: "flow.md" })).toBeVisible();
});

test("navigates nested Groups and keeps multi-Flow root Runs separate", async () => {
  const grouped = decodeRoot({
    ...local,
    flows: local.flows.map((flow) => ({
      ...flow,
      groupPath: ["Commerce", "Checkout"],
    })),
    recordings: [recording],
    runs: [
      ...local.runs,
      {
        ...run,
        flowNames: local.flows.map((flow) => flow.name),
        ownerFlow: null,
        runId: "agentrun-multi",
        title: "Compare journeys",
      },
    ],
  });
  rpc.browse = browse([grouped]);
  render(
    <TestRegistry>
      <FlowsDrawer session={undefined} />
    </TestRegistry>
  );
  const commerce = screen.getByRole("treeitem", { name: "Commerce" });
  expect(screen.getByRole("treeitem", { name: "Checkout" })).toBeVisible();
  commerce.focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(commerce).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("treeitem", { name: "Checkout" })).toBeNull();
  await userEvent.keyboard("{ArrowRight}{ArrowDown}");
  expect(screen.getByRole("treeitem", { name: "Checkout" })).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /Compare journeys/u })
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: /recording-retained/u })
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Root Runs/u }));
  expect(
    screen.getByRole("button", { name: /Compare journeys/u })
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /recording-retained/u })
  ).toBeNull();
});

test("shows a Run's findings beside its assessment in the Details pane", () => {
  render(
    <TestRegistry>
      <FlowDetails
        selection={{
          kind: "run",
          run: {
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
          scope: "local",
        }}
      />
    </TestRegistry>
  );
  const findings = screen.getByRole("region", { name: "Findings" });
  expect(within(findings).getByText("1 finding")).toBeVisible();
  expect(within(findings).getByText("Not working")).toBeVisible();
  expect(
    within(findings).getByText("The resend link stayed disabled.")
  ).toBeVisible();
});

test("opens a native Run in its device session's Workspace view", () => {
  const sessionId = `agent-android-${"d".repeat(32)}`;
  render(
    <TestRegistry>
      <FlowDetails
        selection={{
          kind: "run",
          run: Schema.decodeUnknownSync(CatalogRunEntry)({
            ...run,
            assessment: null,
            kind: "dry-run",
            native: { platform: "android", sessionId },
            outcome: "user-closed",
            ownerFlow: "1mg mobile login",
            runId: `agentrun-${sessionId}`,
            title: "Android Dry Run · 1mg mobile login",
          }),
          scope: "local",
        }}
      />
    </TestRegistry>
  );
  expect(screen.getByText("Android Dry Run")).toBeVisible();
  // A native Dry Run still opens: its session's ended view shows it.
  expect(
    screen.getByRole("link", { name: "Open Run Summary" })
  ).toHaveAttribute("href", `/?android=${sessionId}`);
});
