import { CatalogRootView } from "@contingency/protocol";
import type { CatalogBrowseResult } from "@contingency/protocol";
import {
  RegistryProvider,
  useAtomRefresh,
  useAtomValue,
} from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { SkillDetails } from "@/components/catalog/skill-details";
import { SkillsDrawer } from "@/components/catalog/skills-drawer";
import {
  availableFolder,
  defaultFolder,
  looseRuns,
  opensGlobal,
  orphanRecordings,
  sessionSkills,
  showsSkillsEntry,
  skillsSelectionAtom,
} from "@/components/catalog/skills-drawer-state";
import { stepInstruction } from "@/components/catalog/skills-format";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

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
  flowSkillNames: ["1mg mobile login"],
  kind: "interactive",
  outcome: "completed",
  recordingId: null,
  runId: "agentrun-login",
  startedAt: "2026-10-04T16:13:28.000Z",
  title: "Sign in with a fresh SMS code",
} as const;

const decodeRoot = Schema.decodeUnknownSync(CatalogRootView);

const local = decodeRoot({
  flowSkills: [
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
      flowSkillNames: [],
      runId: "agentrun-loose",
      title: "Explore the store",
    },
  ],
  scope: "local",
  unreadable: 0,
});

const global = decodeRoot({
  flowSkills: [
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
  flowSkills: [],
  present: false,
  runs: [],
});

const browse = (roots: readonly CatalogRootView[]) => ({
  _tag: "Success" as const,
  value: { roots } satisfies CatalogBrowseResult,
  waiting: false,
});

const teaching = (captureState: string) =>
  ({ activity: "teaching", captureState, flowSkillName: "cart" }) as const;

const recording = {
  cleanup: "pending",
  createdAt: "2026-10-04T16:13:28.000Z",
  flowSkillName: "1mg mobile login",
  keyframeCount: 2,
  phase: "skill-drafted",
  recordingId: "recording-retained",
} as const;

const retained = decodeRoot({
  ...local,
  flowSkills: [],
  recordings: [recording],
});

const RefreshCatalog = () => {
  const refresh = useAtomRefresh(rpcOverrides.catalogBrowseAtom);
  return (
    <button onClick={refresh} type="button">
      Refresh catalog
    </button>
  );
};

const SelectedDetails = () => {
  const selection = useAtomValue(skillsSelectionAtom);
  return selection === null ? null : <SkillDetails selection={selection} />;
};

test("selects nonempty folders local-first after Teaching and session skills", () => {
  const none = sessionSkills();
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
    kind: "skill",
    name: "Staging SSO login",
    scope: "global",
  });
  expect(
    defaultFolder([retained, global], sessionSkills(teaching("setup")))
  ).toEqual({ kind: "skill", name: "cart", scope: "local" });
  expect(
    defaultFolder(
      [retained, global],
      sessionSkills({
        activity: "run",
        dryRun: false,
        flowSkillNames: ["Staging SSO login"],
      })
    )
  ).toEqual({ kind: "skill", name: "Staging SSO login", scope: "global" });
  expect(
    opensGlobal(
      [emptyLocal, decodeRoot({ ...retained, scope: "global" })],
      "",
      none
    )
  ).toBe(true);
  expect(opensGlobal([recordingOnly, global], "", none)).toBe(false);
});

test("groups recordings only under skills listed in their own root", () => {
  expect(
    orphanRecordings(decodeRoot({ ...local, recordings: [recording] }))
  ).toEqual([]);
  expect(orphanRecordings(retained)).toEqual([recording]);
});

test("restores retained Runs and orphan recordings when the filter clears", async () => {
  rpc.browse = browse([retained]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.queryByText("No Flow Skills yet")).toBeNull();
  expect(screen.getByRole("button", { name: /Other runs/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(
    screen.getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toBeVisible();
  await userEvent.type(screen.getByLabelText("Filter skills"), "missing");
  expect(
    screen.queryByRole("button", { name: /Other recordings/u })
  ).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Show all skills" })
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Other recordings/u })
  );
  expect(
    screen.getByRole("button", { name: /recording-retained/u })
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "SKILL.md" })).toBeNull();
});

test("opens global-only orphan recordings with no nonexistent skill action", async () => {
  const root = decodeRoot({ ...retained, runs: [], scope: "global" });
  rpc.browse = browse([emptyLocal, root]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
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

test("counts Global history without double-counting listed-skill entries", async () => {
  const root = decodeRoot({
    ...local,
    recordings: [
      recording,
      {
        ...recording,
        flowSkillName: "deleted-cart",
        recordingId: "recording-orphan",
      },
    ],
    scope: "global",
  });
  rpc.browse = browse([emptyLocal, root]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByRole("button", { name: /Global\s*4/u })).toBeVisible();
  await userEvent.type(screen.getByLabelText("Filter skills"), "1mg");
  expect(screen.getByRole("button", { name: /Global\s*1/u })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.getByRole("button", { name: /Global\s*4/u })).toBeVisible();
});

test("refresh replaces a removed selected skill with retained history, then emptiness", async () => {
  rpc.browse = browse([local]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
      <RefreshCatalog />
    </TestRegistry>
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Ridgeline Boulder cart/u })
  );
  rpc.browse = browse([retained]);
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh catalog" })
  );
  expect(screen.getByRole("button", { name: /Other runs/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.queryByRole("button", { name: "SKILL.md" })).toBeNull();
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
  expect(screen.getByText("No Flow Skills yet")).toBeVisible();
  expect(
    availableFolder(
      { kind: "recordings", scope: "global" },
      [emptyLocal],
      sessionSkills()
    )
  ).toBeUndefined();
});

test("hides the Skills entry only while the journey is captured", () => {
  expect(showsSkillsEntry()).toBe(true);
  expect(showsSkillsEntry(teaching("setup"))).toBe(true);
  expect(showsSkillsEntry(teaching("recording"))).toBe(false);
  expect(showsSkillsEntry(teaching("finalizing"))).toBe(false);
  expect(showsSkillsEntry(teaching("ready"))).toBe(true);
  expect(
    showsSkillsEntry({ activity: "run", dryRun: false, flowSkillNames: [] })
  ).toBe(true);
});

test("marks the session's own skill by where it stands", () => {
  expect(
    sessionSkills({
      activity: "teaching",
      captureState: "setup",
      flowSkillName: "cart",
    })
  ).toEqual({ labels: new Map(), pending: "cart" });
  expect(
    sessionSkills({
      activity: "teaching",
      captureState: "skill-drafted",
      flowSkillName: "cart",
    }).labels.get("cart")
  ).toBe("This session");
  expect(
    sessionSkills({
      activity: "run",
      dryRun: true,
      flowSkillNames: ["cart"],
    }).labels.get("cart")
  ).toBe("This Dry Run");
  expect([
    ...sessionSkills({
      activity: "run",
      dryRun: false,
      flowSkillNames: ["login", "cart"],
    }).labels.entries(),
  ]).toEqual([
    ["login", "In this run"],
    ["cart", "In this run"],
  ]);
});

test("opens on the session's skill, then on the first local skill", () => {
  const none = sessionSkills();
  expect(defaultFolder([local, global], none)).toEqual({
    kind: "skill",
    name: "1mg mobile login",
    scope: "local",
  });
  expect(
    defaultFolder(
      [local, global],
      sessionSkills({
        activity: "run",
        dryRun: false,
        flowSkillNames: ["Staging SSO login"],
      })
    )
  ).toEqual({ kind: "skill", name: "Staging SSO login", scope: "global" });
  expect(defaultFolder([emptyLocal], none)).toBeUndefined();
});

test("unfolds Global only when it is the one place with a match", () => {
  const none = sessionSkills();
  expect(opensGlobal([local, global], "", none)).toBe(false);
  expect(opensGlobal([emptyLocal, global], "", none)).toBe(true);
  expect(opensGlobal([local, global], "staging", none)).toBe(true);
  expect(opensGlobal([local, global], "nothing", none)).toBe(false);
});

test("lists local skills, folds Global, and opens a skill's Runs", async () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  const catalog = screen.getByRole("region", { name: "Catalog" });
  expect(
    within(catalog).getByRole("button", { name: /1mg mobile login/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    within(catalog).getByRole("button", { name: /Verified · 1 run/u })
  ).toBeInTheDocument();
  expect(within(catalog).queryByText("Staging SSO login")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Sign in with a fresh SMS code/u })
  ).toBeInTheDocument();

  await userEvent.click(
    within(catalog).getByRole("button", { name: /Ridgeline Boulder cart/u })
  );
  expect(screen.getByText(/A passing Dry Run is the next step/u)).toBeVisible();

  await userEvent.click(
    within(catalog).getByRole("button", { name: /Other runs/u })
  );
  expect(
    screen.getByRole("button", { name: /Explore the store/u })
  ).toBeInTheDocument();
});

test("holds a place for a skill still being taught", () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <SkillsDrawer
        session={{
          activity: "teaching",
          captureState: "setup",
          flowSkillName: "New cart",
        }}
      />
    </TestRegistry>
  );
  expect(
    screen.getByRole("button", { name: /New cart.*Being taught/u })
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Not saved yet")).toBeVisible();
});

test("says so when neither root has a skill", () => {
  rpc.browse = browse([emptyLocal, decodeRoot({ ...global, flowSkills: [] })]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByText("No Flow Skills yet")).toBeVisible();
});

test("names the miss and offers every skill again", async () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  await userEvent.type(screen.getByLabelText("Filter skills"), "checkout");
  expect(screen.getByText("No skill matches “checkout”")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Show all skills" })
  );
  expect(screen.getByLabelText("Filter skills")).toHaveValue("");
});

test("files a Run under Other runs when no listed skill claims it", () => {
  const example = { ...run, flowSkillNames: ["example-delivery-cart"] };
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
      <SkillsDrawer session={undefined} />
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
    screen.getByRole("button", { name: /Ridgeline Boulder cart/u })
  );
  expect(screen.getByText(/A passing Dry Run is the next step/u)).toBeVisible();
});

test("shows the combined plural warning with the empty state", () => {
  rpc.browse = browse([
    decodeRoot({ ...emptyLocal, present: true, unreadable: 1 }),
    decodeRoot({ ...global, flowSkills: [], unreadable: 2 }),
  ]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "3 catalog documents could not be read."
  );
  expect(screen.getByText("No Flow Skills yet")).toBeVisible();
  expect(screen.queryByText("The catalog could not be read")).toBeNull();
});

test("omits the unreadable warning for a healthy catalog", () => {
  rpc.browse = browse([local, global]);
  render(
    <TestRegistry>
      <SkillsDrawer session={undefined} />
    </TestRegistry>
  );
  expect(screen.queryByRole("status")).toBeNull();
});
