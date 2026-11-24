import type {
  AgentRunId,
  CatalogFlowEntry,
  CatalogRecordingEntry,
  CatalogRootScope,
  CatalogRootView,
  CatalogRunEntry,
  FlowName,
} from "@contingency/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ClapperboardIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ReactNode, UIEvent } from "react";

import { NativeRunSummary } from "@/components/agent/android-run-summary";
import {
  DryRunSummaryView,
  InteractiveRunSummaryView,
} from "@/components/agent/dry-run-summary";
import {
  isTaskDryRunSummary,
  isTaskInteractiveRunSummary,
} from "@/components/agent/dry-run-summary-state";
import type { SummaryVerdictTone } from "@/components/agent/dry-run-summary-state";
import { EvidenceReference } from "@/components/agent/evidence-reference";
import { FailureText } from "@/components/agent/failure-reference";
import { PlatformIcon } from "@/components/agent/platform-icons";
import { VerdictCard } from "@/components/agent/run-summary-verdict";
import { RunSummaryView } from "@/components/agent/run-view";
import { FlowMarkdown } from "@/components/catalog/flow-markdown";
import {
  assessmentLabel,
  recordingPhaseLabel,
  runDuration,
  runKindLabel,
  runVerdict,
  when,
} from "@/components/catalog/flows-format";
import type {
  FlowPlatform,
  FlowsFolder,
  SessionFlows,
} from "@/components/catalog/flows-page-state";
import {
  availableFolder,
  defaultFolder,
  flowPlatform,
  flowsOriginAtom,
  folderOfRun,
  looseRuns,
  matchesQuery,
  orphanRecordings,
  recordingsForFlow,
  rootHistoryCount,
  runsForFlow,
  sameFolder,
  sessionFlows,
  showsGlobalAtFirst,
} from "@/components/catalog/flows-page-state";
import { OutcomeChip } from "@/components/catalog/flows-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Listbox, ListboxItem } from "@/components/ui/listbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import {
  Tree,
  TreeGroup,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
} from "@/components/ui/tree";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

/** The page's islands sit under the top chrome, 72px from the top. */
const PANE =
  "island flex min-h-0 flex-col overflow-hidden motion-safe:animate-[flows-pane-in_0.42s_0.2s_var(--ease-workspace-out)_both]";

const ROOT_PATH = { global: "~/.contingency", local: "contingency/" } as const;

const PLATFORM_NAME: Record<FlowPlatform, string> = {
  android: "Android",
  ios: "iOS",
  web: "Web",
};

/** A count beside a heading, in a bordered pill. */
const CountPill = ({ children }: { readonly children: ReactNode }) => (
  <span className="bg-island-hover text-muted-foreground ring-island-border inline-grid h-5 min-w-5 place-items-center rounded-[7px] px-1.5 font-mono text-xs leading-none font-semibold tabular-nums ring-1 ring-inset">
    {children}
  </span>
);

/* ------------------------------------------------------------------ catalog */

interface GroupNode {
  readonly children: readonly TreeNode[];
  readonly kind: "group";
  readonly label: string;
  readonly value: string;
}

type TreeNode =
  | GroupNode
  | {
      readonly flow: CatalogFlowEntry;
      readonly kind: "flow";
      readonly value: string;
    };

const flowValue = (scope: CatalogRootScope, name: string) =>
  `flow:${scope}:${name}`;

/** Groups keep their directory hierarchy; a Flow's identity is its name. */
const toTree = (
  flows: readonly CatalogFlowEntry[],
  scope: CatalogRootScope,
  depth = 0,
  prefix = ""
): TreeNode[] => {
  const groups = [
    ...new Set(flows.flatMap((flow) => flow.groupPath[depth] ?? [])),
  ].toSorted();
  return [
    ...groups.map((group): TreeNode => {
      const path = `${prefix}${group}/`;
      return {
        children: toTree(
          flows.filter((flow) => flow.groupPath[depth] === group),
          scope,
          depth + 1,
          path
        ),
        kind: "group",
        label: group,
        value: `group:${scope}:${path}`,
      };
    }),
    ...flows.flatMap((flow): TreeNode[] =>
      flow.groupPath.length === depth
        ? [{ flow, kind: "flow", value: flowValue(scope, flow.name) }]
        : []
    ),
  ];
};

const groupValues = (nodes: readonly TreeNode[]): string[] =>
  nodes.flatMap((node) =>
    node.kind === "group" ? [node.value, ...groupValues(node.children)] : []
  );

const FlowMark = ({ verified }: { readonly verified: boolean }) =>
  verified ? (
    <ShieldCheckIcon
      aria-label="Verified"
      className="text-status-ready size-3.5 shrink-0"
      role="img"
    />
  ) : (
    <CircleDashedIcon
      aria-label="Drafted"
      className="text-muted-foreground size-3.5 shrink-0"
      role="img"
    />
  );

/** A Flow's mark in the tree: its platform, or a document when unknown. */
const FlowGlyph = ({
  platform,
}: {
  readonly platform: FlowPlatform | undefined;
}) =>
  platform === undefined ? (
    <FileTextIcon
      aria-hidden="true"
      className="text-muted-foreground ml-[22px] size-[15px] shrink-0"
    />
  ) : (
    <span
      className="text-muted-foreground ml-[22px] inline-grid shrink-0"
      title={PLATFORM_NAME[platform]}
    >
      <PlatformIcon className="size-[15px]" platform={platform} />
    </span>
  );

const TreeRows = ({
  labels,
  nodes,
  root,
}: {
  readonly labels: ReadonlyMap<string, string>;
  readonly nodes: readonly TreeNode[];
  readonly root: CatalogRootView;
}) =>
  nodes.map((node) => (
    <TreeItem key={node.value} value={node.value}>
      <TreeItemLabel>
        {node.kind === "group" ? (
          <>
            <TreeItemIndicator>
              <ChevronRightIcon aria-hidden="true" />
            </TreeItemIndicator>
            <FolderIcon
              aria-hidden="true"
              className="text-muted-foreground size-[15px] shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">{node.label}</span>{" "}
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {node.children.length}
            </span>
          </>
        ) : (
          <>
            <FlowGlyph platform={flowPlatform(root, node.flow)} />
            <span className="min-w-0 flex-1 truncate">
              {node.flow.name}
            </span>{" "}
            {labels.has(node.flow.name) ? (
              <span className="bg-status-running/14 text-status-running rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap">
                {labels.get(node.flow.name)}
              </span>
            ) : null}
            <FlowMark verified={node.flow.verified} />
          </>
        )}
      </TreeItemLabel>
      {node.kind === "group" ? (
        <TreeGroup>
          <TreeRows labels={labels} nodes={node.children} root={root} />
        </TreeGroup>
      ) : null}
    </TreeItem>
  ));

const rowButton =
  "hover:bg-island-hover flex min-h-8 w-full items-center gap-2 rounded-[10px] px-2 text-left text-[13.5px] data-pressed:bg-brand/14 data-pressed:ring-1 data-pressed:ring-brand/30 data-pressed:ring-inset focus-visible:outline-2 focus-visible:outline-brand-ink focus-visible:-outline-offset-2";

const RootSection = ({
  flows,
  folder,
  onFolder,
  query,
  root,
}: {
  readonly flows: SessionFlows;
  readonly folder: FlowsFolder | undefined;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly query: string;
  readonly root: CatalogRootView;
}) => {
  const listed = root.flows.filter((flow) => matchesQuery(flow, query));
  const nodes = toTree(listed, root.scope);
  const filtering = query.trim() !== "";
  const history = rootHistoryCount(root, flows.pending);
  const pending =
    root.scope === "local" &&
    flows.pending !== undefined &&
    !root.flows.some((flow) => flow.name === flows.pending)
      ? flows.pending
      : undefined;
  const rootFolder: FlowsFolder = { kind: "root", scope: root.scope };
  const headingId = `flows-root-${root.scope}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-px">
      <h2
        className="text-muted-foreground mt-1 mb-0.5 flex items-center gap-1.5 px-2 py-1 font-mono text-xs font-medium"
        id={headingId}
        title={root.path}
      >
        {ROOT_PATH[root.scope]}
        <span className="text-muted-foreground/80 font-sans text-xs font-normal">
          {root.scope === "local" ? "Local" : "Global · read-only"}
        </span>
      </h2>
      {pending === undefined ? null : (
        <Toggle
          className={cn(rowButton, "border border-dashed")}
          onPressedChange={() => {
            onFolder({ kind: "flow", name: pending, scope: "local" });
          }}
          pressed={sameFolder(folder, {
            kind: "flow",
            name: pending,
            scope: "local",
          })}
          variant="unstyled"
        >
          <CircleDashedIcon
            aria-hidden="true"
            className="text-muted-foreground size-[15px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{pending}</span>{" "}
          <span className="text-muted-foreground text-xs">Being taught</span>
        </Toggle>
      )}
      {root.present ? null : (
        <p className="text-muted-foreground mx-2.5 my-1 text-xs text-pretty">
          No <code>contingency</code> folder at{" "}
          <code className="break-all">{root.path}</code>.
        </p>
      )}
      {nodes.length === 0 &&
      root.present &&
      (filtering || root.flows.length > 0) ? (
        <p className="text-muted-foreground mx-2.5 my-1 text-xs">
          No Flow matches.
        </p>
      ) : null}
      {nodes.length === 0 ? null : (
        <Tree
          aria-label={`${root.scope === "local" ? "Local" : "Global"} Flows`}
          // Every Group starts open, so a match is never hidden in one.
          defaultExpanded={groupValues(nodes)}
          key={filtering ? "search" : "all"}
          onValueChange={(value: string | string[] | null) => {
            const flow = listed.find(
              (entry) => flowValue(root.scope, entry.name) === value
            );
            if (flow !== undefined) {
              onFolder({ kind: "flow", name: flow.name, scope: root.scope });
            }
          }}
          value={
            folder?.kind === "flow" && folder.scope === root.scope
              ? flowValue(root.scope, folder.name)
              : null
          }
        >
          <TreeRows labels={flows.labels} nodes={nodes} root={root} />
        </Tree>
      )}
      {history === 0 || filtering ? null : (
        <Toggle
          className={cn(rowButton, "mt-1")}
          onPressedChange={() => {
            onFolder(rootFolder);
          }}
          pressed={sameFolder(folder, rootFolder)}
          variant="unstyled"
        >
          <CircleDotIcon
            aria-hidden="true"
            className="text-muted-foreground size-[15px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">Runs without one Flow</span>{" "}
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {history}
          </span>
        </Toggle>
      )}
    </section>
  );
};

const Catalog = ({
  flows,
  folder,
  onFolder,
  roots,
}: {
  readonly flows: SessionFlows;
  readonly folder: FlowsFolder | undefined;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly roots: readonly CatalogRootView[];
}) => {
  const [queryAtom] = useState(() => Atom.make(""));
  const [query, setQuery] = useAtom(queryAtom);
  // The user-global root stays out of the way until the Global filter shows it.
  const [globalAtom] = useState(() =>
    Atom.make(showsGlobalAtFirst(roots, folder))
  );
  const [showGlobal, setShowGlobal] = useAtom(globalAtom);
  const local = roots.find((root) => root.scope === "local");
  const global = roots.find((root) => root.scope === "global");
  const count = roots
    .filter((root) => showGlobal || root.scope === "local")
    .reduce((total, root) => total + root.flows.length, 0);
  return (
    <aside
      aria-label="Catalog"
      className="island fixed top-[4.5rem] bottom-4 left-4 z-10 flex min-h-0 w-[14.5rem] flex-col overflow-hidden px-2 pt-3.5 pb-2 xl:w-[17.5rem]"
      data-vt="flows-sidebar"
    >
      <div className="flex items-center gap-2 px-2 pb-2.5">
        <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Flows</h1>
        <CountPill>{count}</CountPill>
        {global === undefined ? null : (
          <Toggle
            // The outline look fills dark mode with `dark:bg-input/30`, so the
            // pressed fill repeats under `dark:` to keep solid ink there too.
            className="text-muted-foreground hover:text-foreground data-pressed:bg-foreground data-pressed:text-background data-pressed:hover:bg-foreground/90 data-pressed:hover:text-background dark:data-pressed:bg-foreground dark:data-pressed:hover:bg-foreground/90 ml-auto h-[26px] gap-1.5 rounded-lg px-2 text-xs data-pressed:border-transparent dark:data-pressed:border-transparent"
            onPressedChange={setShowGlobal}
            pressed={showGlobal}
            size="xs"
            title={global.path}
            variant="outline"
          >
            <GlobeIcon aria-hidden="true" />
            Global
          </Toggle>
        )}
      </div>
      <label className="bg-island-hover ring-island-border focus-within:ring-brand-ink mx-0.5 mb-2 flex h-[34px] items-center gap-2 rounded-xl px-2.5 ring-1 ring-inset focus-within:ring-[1.5px]">
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground size-[15px] shrink-0"
        />
        <Input
          variant="compact"
          aria-label="Search Flows"
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          placeholder="Search Flows"
          value={query}
        />
      </label>
      <div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto">
        {local === undefined ? null : (
          <RootSection
            flows={flows}
            folder={folder}
            onFolder={onFolder}
            query={query}
            root={local}
          />
        )}
        {global === undefined || !showGlobal ? null : (
          <RootSection
            flows={flows}
            folder={folder}
            onFolder={onFolder}
            query={query}
            root={global}
          />
        )}
      </div>
    </aside>
  );
};

/* ----------------------------------------------------------------- doc pane */

const Chip = ({
  children,
  className,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly tone?: "neutral" | "ready";
}) => (
  <span
    className={cn(
      "status-chip [&_svg]:size-3.5",
      tone === "neutral" && "[--status-tone:var(--muted-foreground)]",
      className
    )}
    data-status={tone === "ready" ? "ready" : undefined}
  >
    {children}
  </span>
);

const FlowFiles = ({
  name,
  scope,
}: {
  readonly name: FlowName;
  readonly scope: CatalogRootScope;
}) => {
  const { catalogFlowAtom } = useRpcDependencies();
  const result = useAtomValue(catalogFlowAtom(scope)(name));
  const [fileAtom] = useState(() => Atom.make("flow.md"));
  const [file, setFile] = useAtom(fileAtom);
  if (result._tag === "Initial") {
    return (
      <p className="text-muted-foreground px-5 py-4 text-sm">
        Reading flow.md…
      </p>
    );
  }
  if (result._tag === "Failure") {
    return (
      <Alert className="m-4 w-auto" variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>This Flow could not be read</AlertTitle>
        <AlertDescription>
          <FailureText
            text={refusal(result) ?? "Its flow.md is no longer there."}
          />
        </AlertDescription>
      </Alert>
    );
  }
  const paths = result.value.files.map((entry) => entry.path);
  return (
    <Tabs
      className="flex min-h-0 flex-1 flex-col gap-0"
      onValueChange={(value: string | null) => {
        if (value !== null) {
          setFile(value);
        }
      }}
      value={paths.includes(file) ? file : (paths[0] ?? null)}
    >
      <TabsList
        aria-label="Flow files"
        className="w-full justify-start"
        variant="file"
      >
        {result.value.files.map((entry) => (
          <TabsTrigger key={entry.path} value={entry.path}>
            <FileTextIcon aria-hidden="true" />
            {entry.path}
          </TabsTrigger>
        ))}
      </TabsList>
      {result.value.files.map((entry) => (
        <TabsContent
          className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5"
          key={entry.path}
          value={entry.path}
        >
          {entry.path.endsWith(".md") ? (
            <FlowMarkdown
              files={paths}
              onFile={setFile}
              source={entry.content}
            />
          ) : (
            <pre className="bg-island-hover ring-island-border overflow-x-auto rounded-xl p-3 font-mono text-xs leading-5 ring-1 ring-inset">
              {entry.content}
            </pre>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
};

const FlowPane = ({
  flow,
  name,
  platform,
  scope,
}: {
  /** Absent while the Flow is still being taught. */
  readonly flow: CatalogFlowEntry | undefined;
  readonly name: string;
  readonly platform: FlowPlatform | undefined;
  readonly scope: CatalogRootScope;
}) => {
  const title = [...(flow?.groupPath ?? []), name].join(" / ");
  let standing = (
    <Chip>
      <CircleDashedIcon aria-hidden="true" />
      {flow === undefined ? "Being taught" : "Drafted"}
    </Chip>
  );
  if (flow?.verified === true) {
    standing = (
      <Chip tone="ready">
        <ShieldCheckIcon aria-hidden="true" />
        Verified
      </Chip>
    );
  }
  return (
    <section aria-label={name} className={PANE}>
      <header className="border-island-border grid gap-2 border-b px-5 pt-[18px] pb-3.5">
        <div className="flex flex-wrap gap-1.5">
          {standing}
          {platform === undefined ? null : (
            <Chip>
              <PlatformIcon platform={platform} />
              {PLATFORM_NAME[platform]}
            </Chip>
          )}
          {/* No icon: a globe would read as the Web platform. */}
          {scope === "global" ? <Chip>Global</Chip> : null}
          {flow?.demo === undefined ? null : <Chip>Demo site</Chip>}
        </div>
        <h2 className="font-mono text-[17px] font-semibold tracking-[-0.02em] wrap-anywhere">
          {title}
        </h2>
        {flow === undefined || flow.hosts.length === 0 ? null : (
          <dl
            className="bg-island-hover grid gap-1 rounded-xl px-3 py-2.5 text-[12.5px]"
            title="Stamped by Contingency"
          >
            <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">
                {flow.hosts.length === 1 ? "Host" : "Hosts"}
              </dt>
              <dd className="font-mono text-xs wrap-anywhere">
                {flow.hosts.join(", ")}
              </dd>
            </div>
          </dl>
        )}
      </header>
      {flow === undefined ? (
        <p className="text-muted-foreground px-5 py-4 text-sm text-pretty">
          After you stop recording, the agent learns the recording and drafts{" "}
          <code className="wrap-anywhere">{name}/flow.md</code> here.
        </p>
      ) : (
        <FlowFiles name={flow.name} scope={scope} />
      )}
    </section>
  );
};

const FlowPills = ({
  names,
  onFolder,
  scope,
}: {
  readonly names: readonly FlowName[];
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly scope: CatalogRootScope;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const result = useAtomValue(catalogBrowseAtom);
  const root =
    result._tag === "Success"
      ? result.value.roots.find((entry) => entry.scope === scope)
      : undefined;
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name) =>
        // A Run can name a Flow this root no longer holds, or a bundled
        // Example that was never in it; that name is shown, not offered.
        root?.flows.some((flow) => flow.name === name) === true ? (
          <Button
            className="rounded-lg font-mono text-xs"
            key={name}
            onClick={() => {
              onFolder({ kind: "flow", name, scope });
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            {name}
          </Button>
        ) : (
          <code
            className="text-muted-foreground rounded-lg border border-dashed px-2 py-0.5 text-xs"
            key={name}
            title="Not in this Catalog Root"
          >
            {name}
          </code>
        )
      )}
    </div>
  );
};

const RootPane = ({
  onFolder,
  run,
  scope,
}: {
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry | undefined;
  readonly scope: CatalogRootScope;
}) => (
  <section aria-label="Runs without one Flow" className={PANE}>
    <header className="border-island-border grid gap-2 border-b px-5 pt-[18px] pb-3.5">
      <div className="flex flex-wrap gap-1.5">
        <Chip>Catalog Root</Chip>
      </div>
      <h2 className="font-mono text-[17px] font-semibold tracking-[-0.02em]">
        Runs without one Flow
      </h2>
      <p className="text-muted-foreground text-sm text-pretty">
        A Run that used no Flow, or several, belongs to{" "}
        <code>{ROOT_PATH[scope]}</code> itself.
      </p>
    </header>
    {run === undefined ? null : (
      <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-5 pt-4 pb-5 text-sm">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-[0.06em] uppercase">
          Requested task
        </h3>
        <p className="text-pretty wrap-anywhere">{run.title}</p>
        <h3 className="text-muted-foreground mt-3 text-xs font-semibold tracking-[0.06em] uppercase">
          Flows it used
        </h3>
        {run.flowNames.length === 0 ? (
          <p className="text-muted-foreground">
            None. The agent worked from the task alone.
          </p>
        ) : (
          <FlowPills names={run.flowNames} onFolder={onFolder} scope={scope} />
        )}
      </div>
    )}
  </section>
);

/* ---------------------------------------------------------------- runs pane */

/**
 * What the catalog itself knows of a Run: its Agent Assessment, the agent's
 * explanation, and its findings. It stands in where this process cannot read
 * the persisted Summary, such as a Run in the user-global root.
 */
/** The catalog's verdict tone, as the full summary would colour it. */
const catalogVerdictTone = (run: CatalogRunEntry): SummaryVerdictTone => {
  if (run.assessment === null) {
    return run.outcome === "completed" || run.outcome === "user-closed"
      ? "attention"
      : "failed";
  }
  if (run.assessment === "working") {
    return "passed";
  }
  return run.assessment === "not-working" ? "failed" : "attention";
};

const CatalogRunSummary = ({
  links,
  note,
  onFolder,
  run,
  scope,
}: {
  /** Ways out of the summary, such as the Run's device session. */
  readonly links?: ReactNode;
  readonly note: ReactNode;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => {
  const findings = run.findings ?? [];
  return (
    <section aria-label="Run Summary" className="grid gap-3 text-sm">
      <VerdictCard
        facts={[runKindLabel(run), when(run.startedAt), runDuration(run)]}
        verdict={{ label: runVerdict(run), tone: catalogVerdictTone(run) }}
      />
      <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-balance wrap-anywhere">
        {run.title}
      </h3>
      {run.explanation === undefined ? null : (
        <p className="text-muted-foreground -mt-1 text-pretty wrap-anywhere">
          {run.explanation}
        </p>
      )}
      {findings.length === 0 ? null : (
        <section aria-label="Findings" className="grid gap-1.5">
          <h4 className="text-muted-foreground text-xs font-semibold tracking-[0.06em] uppercase">
            {findings.length === 1
              ? "1 finding"
              : `${findings.length} findings`}
          </h4>
          <ul className="grid gap-1.5">
            {findings.map((finding) => (
              <li className="flex items-start gap-2" key={finding.id}>
                <span className="status-chip shrink-0 [--status-tone:var(--muted-foreground)]">
                  {assessmentLabel(finding.outcome)}
                </span>
                <span className="min-w-0 text-pretty wrap-anywhere">
                  {finding.explanation}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.flowNames.length > 1 ? (
        <section aria-label="Flows" className="grid gap-1.5">
          <h4 className="text-muted-foreground text-xs font-semibold tracking-[0.06em] uppercase">
            Flows
          </h4>
          <FlowPills names={run.flowNames} onFolder={onFolder} scope={scope} />
        </section>
      ) : null}
      <footer className="border-island-border flex flex-wrap items-center gap-2 border-t pt-3">
        <EvidenceReference id={run.runId} kind="Run ID" />
        {links === undefined ? null : (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {links}
          </div>
        )}
      </footer>
      <p className="text-muted-foreground text-xs text-pretty">{note}</p>
    </section>
  );
};

/**
 * The Run's persisted Summary, read from this process's Run store: its video,
 * the assessment and findings, Browser Checks, Scan Reports and Browser
 * Modifications.
 */
/** Said under a verified Flow's Dry Run, whose evidence Cleanup deleted. */
const CLEANED_DRY_RUN =
  "Cleanup deleted this Dry Run's video and Browser Trace when the Flow was verified. Its Run Summary is kept.";

const StoredRunSummary = ({
  cleanup,
  onFolder,
  run,
}: {
  readonly cleanup: CatalogRecordingEntry["cleanup"] | null;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
}) => {
  const { agentRunSummaryAtom } = useRpcDependencies();
  const result = useAtomValue(agentRunSummaryAtom(run.runId));
  if (result._tag === "Initial") {
    return <p className="text-muted-foreground text-sm">Loading the Run…</p>;
  }
  if (result._tag === "Failure") {
    return (
      <CatalogRunSummary
        note={`Its full Run Summary could not be read. ${refusal(result) ?? ""}`.trim()}
        onFolder={onFolder}
        run={run}
        scope="local"
      />
    );
  }
  const { summary } = result.value;
  if (isTaskDryRunSummary(summary)) {
    return (
      <section aria-label="Run Summary">
        <DryRunSummaryView
          links={
            run.recordingId === null ? null : (
              <a
                className={buttonVariants({ size: "xs", variant: "outline" })}
                href={`/?recording=${run.recordingId}`}
              >
                Dry Run review
              </a>
            )
          }
          summary={summary}
        />
        {cleanup === "purged" ? (
          <p className="text-muted-foreground mt-3 text-xs text-pretty">
            {CLEANED_DRY_RUN}
          </p>
        ) : null}
      </section>
    );
  }
  if (isTaskInteractiveRunSummary(summary)) {
    return (
      <section aria-label="Run Summary">
        <InteractiveRunSummaryView summary={summary} />
      </section>
    );
  }
  return <RunSummaryView heading={false} summary={summary} />;
};

/** A native Run's link to its device session's ended Workspace view. */
const DeviceSessionLink = ({
  native,
}: {
  readonly native: NonNullable<CatalogRunEntry["native"]>;
}) => (
  <a
    className={buttonVariants({ size: "xs", variant: "outline" })}
    href={`/?${native.platform}=${native.sessionId}`}
  >
    Device session
  </a>
);

/**
 * A native Run's full Run Summary, read from its Flow's Run directory
 * (ADR 0078), with its Run ID and a link to its device session. Without a
 * readable Summary it falls back to what the catalog knows.
 */
const StoredNativeRunSummary = ({
  cleanup,
  flowName,
  native,
  onFolder,
  run,
  scope,
}: {
  readonly cleanup: CatalogRecordingEntry["cleanup"] | null;
  readonly flowName: FlowName;
  readonly native: NonNullable<CatalogRunEntry["native"]>;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => {
  const { catalogNativeRunAtom } = useRpcDependencies();
  const result = useAtomValue(catalogNativeRunAtom(scope)(flowName)(run.runId));
  if (result._tag === "Initial") {
    return <p className="text-muted-foreground text-sm">Loading the Run…</p>;
  }
  if (result._tag === "Failure") {
    return (
      <CatalogRunSummary
        links={<DeviceSessionLink native={native} />}
        note={`Its full Run Summary could not be read. ${refusal(result) ?? ""}`.trim()}
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  }
  const { summary } = result.value;
  return (
    <section aria-label="Run Summary" className="grid gap-4 text-sm">
      {/* The summary carries its own title and Run ID footer. */}
      <NativeRunSummary
        cleanup={cleanup}
        links={<DeviceSessionLink native={native} />}
        summary={summary}
      />
      {scope === "global" ? (
        <p className="text-muted-foreground text-xs text-pretty">
          This Run is stored in ~/.contingency. Its video and screens open only
          in a Workspace serving that root.
        </p>
      ) : null}
    </section>
  );
};

const RunSummary = ({
  cleanup,
  onFolder,
  run,
  scope,
}: {
  /** The Cleanup of the recording a Dry Run belongs to, when it is listed. */
  readonly cleanup: CatalogRecordingEntry["cleanup"] | null;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => {
  // A native Run is filed under its one Flow.
  const nativeFlow = run.ownerFlow ?? run.flowNames[0];
  let body: ReactNode;
  if (run.native !== undefined && nativeFlow !== undefined) {
    body = (
      <StoredNativeRunSummary
        cleanup={cleanup}
        flowName={nativeFlow}
        native={run.native}
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  } else if (scope === "global") {
    body = (
      <CatalogRunSummary
        note="This Run is stored in ~/.contingency. Its video and evidence open only in a Workspace serving that root."
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  } else if (run.native === undefined) {
    body = <StoredRunSummary cleanup={cleanup} onFolder={onFolder} run={run} />;
  } else {
    body = (
      <CatalogRunSummary
        links={<DeviceSessionLink native={run.native} />}
        note="Its video and device evidence are in its device session."
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  }
  // Both summaries name themselves "Run Summary", so the pane adds no landmark.
  return <div className="grid grid-cols-[minmax(0,1fr)] gap-3">{body}</div>;
};

/** Recording phases whose Dry Run review has a summary to show. */
const REVIEWED_PHASES = new Set(["dry-run-failed", "dry-run-passed"]);

/**
 * A Teaching Recording, named by the Flow it teaches. Its id is copied, not
 * read: it stays in the copy button's name and description.
 */
const RecordingSummary = ({
  recording,
}: {
  readonly recording: CatalogRecordingEntry;
}) => (
  <article aria-label="Teaching Recording" className="grid gap-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <Chip>
        <ClapperboardIcon aria-hidden="true" />
        Teaching Recording
      </Chip>
      <span className="text-muted-foreground text-xs">
        {recordingPhaseLabel(recording)} · Taught {when(recording.createdAt)} ·{" "}
        {recording.keyframeCount} keyframes
      </span>
    </div>
    <h3 className="font-mono text-sm font-semibold wrap-anywhere">
      {recording.flowName}
    </h3>
    <p className="bg-island-hover rounded-xl px-3 py-2.5 text-pretty">
      {recording.cleanup === "purged"
        ? "Cleanup removed the video, Browser Trace and events after the Flow was verified. Only the manifest is left."
        : "Sensitive learning evidence. Cleanup deletes it once you verify the Flow, after a passing Dry Run."}
    </p>
    <footer className="border-island-border flex flex-wrap items-center gap-2 border-t pt-3">
      <EvidenceReference id={recording.recordingId} kind="Recording ID" />
      {recording.cleanup !== "purged" &&
      REVIEWED_PHASES.has(recording.phase) ? (
        <a
          className={cn(
            buttonVariants({ size: "xs", variant: "outline" }),
            "ml-auto"
          )}
          href={`/?recording=${recording.recordingId}`}
        >
          Dry Run review
        </a>
      ) : null}
    </footer>
  </article>
);

type Entry =
  | { readonly kind: "run"; readonly run: CatalogRunEntry }
  | { readonly kind: "recording"; readonly recording: CatalogRecordingEntry };

const entryId = (entry: Entry): string =>
  entry.kind === "run" ? entry.run.runId : entry.recording.recordingId;

/** A `?run=` that names no Run listed in this folder. */
const MissingRun = ({ runId }: { readonly runId: AgentRunId }) => (
  <Alert className="m-4 w-auto">
    <CircleAlertIcon aria-hidden="true" />
    <AlertTitle>This Run is not listed here</AlertTitle>
    <AlertDescription>
      No Run <code className="font-mono">{runId}</code> is listed here. It may
      have been deleted, or belong to another Flow. Pick a Run to see its Run
      Summary.
    </AlertDescription>
  </Alert>
);

/** At most this many rows show at once until the list is expanded. */
const VISIBLE_RUN_ROWS = 4;

/**
 * One row's height: a title line, a detail line and the row's padding. The
 * list is sized in whole rows, so the last one is never sliced through its
 * text; rem keeps that true at a larger text size.
 */
const RUN_ROW = "h-[3.125rem]";
/** `VISIBLE_RUN_ROWS` rows, the gaps between them, and the list's padding. */
const RUN_LIST_MAX = "max-h-[calc(4*3.125rem+3*0.125rem+1rem)]";

/** Whether a scrolled list holds more below what it shows. */
const hasMoreBelow = (element: HTMLElement): boolean =>
  element.scrollTop + element.clientHeight < element.scrollHeight - 1;

/** One Run or recording in the list; choosing it shows it below. */
const RunRow = ({ entry }: { readonly entry: Entry }) => (
  <ListboxItem
    className={cn(
      "hover:bg-island-hover data-selected:bg-island-hover data-selected:ring-island-border focus-visible:outline-brand-ink col-span-3 grid grid-cols-subgrid items-center rounded-xl pr-2.5 pl-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 data-selected:ring-1 data-selected:ring-inset",
      RUN_ROW
    )}
    value={entryId(entry)}
  >
    {entry.kind === "run" ? (
      <>
        <OutcomeChip className="justify-self-start" run={entry.run} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {entry.run.title}
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            {runKindLabel(entry.run)} · {when(entry.run.startedAt)}
          </span>
        </span>
        <span className="text-muted-foreground justify-self-end font-mono text-xs tabular-nums">
          {runDuration(entry.run)}
        </span>
      </>
    ) : (
      <>
        <Chip className="justify-self-start">
          <CircleDotIcon aria-hidden="true" />
          Recording
        </Chip>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {recordingPhaseLabel(entry.recording)}
          </span>
          <span className="text-muted-foreground block truncate text-xs">
            Teaching · {when(entry.recording.createdAt)}
          </span>
        </span>
        <span />
      </>
    )}
  </ListboxItem>
);

/**
 * The folder's Runs and Teaching Recordings, newest first. Each Run leads
 * with its outcome as a tinted chip, as wide as its words, and ends on its
 * length; a recording leads with a Recording chip and says where it stands.
 * The rows share one set of columns, so every title starts at one edge.
 *
 * Past four rows the list scrolls, its last row fades while more wait below,
 * and a "Show N more" button under it opens the whole list.
 */
const RunList = ({
  entries,
  onShow,
  shownId,
}: {
  readonly entries: readonly Entry[];
  readonly onShow: (entry: Entry) => void;
  readonly shownId: string | undefined;
}) => {
  const listId = useId();
  const hidden = entries.length - VISIBLE_RUN_ROWS;
  const [moreBelowAtom] = useState(() => Atom.make(true));
  const [moreBelow, setMoreBelow] = useAtom(moreBelowAtom);
  const [expandedAtom] = useState(() => Atom.make(false));
  const [expanded, setExpanded] = useAtom(expandedAtom);
  const capped = hidden > 0 && !expanded;
  return (
    <div className="border-island-border shrink-0 border-b">
      {/*
        Arrows browse the rows; Enter, Space or a press shows one, since
        each choice loads its Run Summary and moves the URL. The folder's
        default Run is already selected, so choosing it again arrives as a
        deselect; it still shows that Run, which pins its ID in the URL.
        The fade lifts while a row has keyboard focus, so a row scrolled to
        the bottom edge keeps its outline.
      */}
      <Listbox
        activation="manual"
        aria-label="Runs and recordings"
        className={cn(
          "grid [scrollbar-width:thin] grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 overflow-y-auto p-2",
          capped && RUN_LIST_MAX,
          capped &&
            moreBelow &&
            "[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] has-[:focus-visible]:[mask-image:none]"
        )}
        deselectable
        id={listId}
        onScroll={(event: UIEvent<HTMLDivElement>) => {
          setMoreBelow(hasMoreBelow(event.currentTarget));
        }}
        onValueChange={(next) => {
          const id = next ?? shownId;
          const entry = entries.find((candidate) => entryId(candidate) === id);
          if (entry !== undefined) {
            onShow(entry);
          }
        }}
        value={shownId ?? null}
      >
        {entries.map((entry) => (
          <RunRow entry={entry} key={entryId(entry)} />
        ))}
      </Listbox>
      {hidden > 0 ? (
        <Button
          aria-controls={listId}
          aria-expanded={expanded}
          className="mb-2 ml-4"
          onClick={() => {
            setExpanded(!expanded);
          }}
          size="xs"
          type="button"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "transition-transform motion-reduce:transition-none",
              expanded && "rotate-180"
            )}
          />
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </Button>
      ) : null}
    </div>
  );
};

const RunsPane = ({
  emptyNote,
  entries,
  missingRun,
  onFolder,
  onShow,
  scope,
  shown,
}: {
  readonly emptyNote: string;
  readonly entries: readonly Entry[];
  readonly missingRun: AgentRunId | undefined;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly onShow: (entry: Entry) => void;
  readonly scope: CatalogRootScope;
  readonly shown: Entry | undefined;
}) => {
  const runs = entries.filter((entry) => entry.kind === "run").length;
  return (
    <section
      aria-label="Runs"
      className={cn(PANE, "motion-safe:[animation-delay:0.26s]")}
    >
      <header className="border-island-border flex items-center gap-2 border-b px-5 py-3.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Runs</h2>
        <CountPill>{runs}</CountPill>
      </header>
      {missingRun === undefined ? null : <MissingRun runId={missingRun} />}
      {entries.length === 0 ? (
        <div className="text-muted-foreground grid flex-1 place-content-center justify-items-center gap-2.5 p-6 text-center text-balance">
          <CircleDotIcon aria-hidden="true" className="size-5" />
          <p className="max-w-[280px]">{emptyNote}</p>
        </div>
      ) : (
        <>
          <RunList
            entries={entries}
            onShow={onShow}
            shownId={shown === undefined ? undefined : entryId(shown)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
            {shown?.kind === "run" ? (
              <RunSummary
                cleanup={
                  entries.flatMap((entry) =>
                    entry.kind === "recording" &&
                    entry.recording.recordingId === shown.run.recordingId
                      ? [entry.recording.cleanup]
                      : []
                  )[0] ?? null
                }
                key={shown.run.runId}
                onFolder={onFolder}
                run={shown.run}
                scope={scope}
              />
            ) : null}
            {shown?.kind === "recording" ? (
              <RecordingSummary recording={shown.recording} />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
};

/* --------------------------------------------------------------------- page */

const folderEntries = (
  root: CatalogRootView,
  folder: FlowsFolder,
  pending: string | undefined
): readonly Entry[] => {
  const runs =
    folder.kind === "flow" ? runsForFlow(root, folder.name) : looseRuns(root);
  const recordings =
    folder.kind === "flow"
      ? recordingsForFlow(root, folder.name)
      : orphanRecordings(root, pending);
  return [
    ...runs.map((run): Entry => ({ kind: "run", run })),
    ...recordings.map((recording): Entry => ({ kind: "recording", recording })),
  ];
};

const FolderPanes = ({
  flows,
  folder,
  onFolder,
  onRun,
  root,
  runId,
}: {
  readonly flows: SessionFlows;
  readonly folder: FlowsFolder;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly onRun: (runId?: AgentRunId) => void;
  readonly root: CatalogRootView;
  readonly runId: AgentRunId | undefined;
}) => {
  const entries = folderEntries(root, folder, flows.pending);
  // A recording is picked here, not in the URL; a Run is `?run=`.
  const [recordingAtom] = useState(() => Atom.make<string | null>(null));
  const [recordingId, setRecordingId] = useAtom(recordingAtom);
  const requested = entries.find(
    (entry) =>
      (entry.kind === "run" && entry.run.runId === runId) ||
      (entry.kind === "recording" &&
        runId === undefined &&
        entry.recording.recordingId === recordingId)
  );
  // A link that names a Run shows that Run or says it is not here; it never
  // shows another Run's report under the requested ID.
  const missingRun =
    runId !== undefined && requested === undefined ? runId : undefined;
  const shown =
    requested ?? (missingRun === undefined ? entries.at(0) : undefined);
  const onShow = (entry: Entry) => {
    if (entry.kind === "run") {
      setRecordingId(null);
      onRun(entry.run.runId);
      return;
    }
    setRecordingId(entry.recording.recordingId);
    onRun();
  };
  const flow =
    folder.kind === "flow"
      ? root.flows.find((entry) => entry.name === folder.name)
      : undefined;
  let emptyNote = "No Runs yet. Ask your agent to run this Flow.";
  if (folder.kind === "flow" && flow === undefined) {
    emptyNote = "Runs of this Flow show here once it is saved.";
  } else if (flow?.verified === false) {
    emptyNote = "No Runs yet. Ask your agent to Dry Run this Flow.";
  }
  return (
    // Sizes follow the text size: at 200% text the panes stack and the page
    // scrolls, rather than clipping the Run Summary.
    <main
      className="fixed top-[4.5rem] right-4 bottom-4 left-[16.25rem] grid auto-rows-[100%] grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-3 overflow-y-auto xl:left-[19.25rem]"
      key={JSON.stringify(folder)}
    >
      {folder.kind === "flow" ? (
        <FlowPane
          flow={flow}
          name={folder.name}
          platform={flow === undefined ? undefined : flowPlatform(root, flow)}
          scope={folder.scope}
        />
      ) : (
        <RootPane
          onFolder={onFolder}
          run={shown?.kind === "run" ? shown.run : undefined}
          scope={folder.scope}
        />
      )}
      <RunsPane
        emptyNote={emptyNote}
        entries={entries}
        missingRun={missingRun}
        onFolder={onFolder}
        onShow={onShow}
        scope={folder.scope}
        shown={shown}
      />
    </main>
  );
};

/** Nothing on disk in either root, and nothing being taught. */
const NoFlows = () => (
  <main className="fixed inset-0 grid place-items-center px-4 py-24">
    <div className="island grid max-w-[420px] justify-items-center gap-2.5 p-8 text-center">
      <BookOpenIcon
        aria-hidden="true"
        className="text-muted-foreground size-5"
      />
      <h1 className="mt-1 text-lg font-semibold tracking-[-0.02em]">
        No Flows yet
      </h1>
      <p className="text-muted-foreground text-pretty">
        Contingency looks in this workspace&rsquo;s <code>contingency</code> and
        in <code>~/.contingency</code>. Teach a Flow from the Workspace home,
        and its Flow, Teaching Recordings and Runs show up here.
      </p>
    </div>
  </main>
);

const CatalogMessage = ({ children }: { readonly children: ReactNode }) => (
  <main className="fixed inset-0 grid place-items-center px-4 py-24">
    <div className="island w-full max-w-[460px] p-4">{children}</div>
  </main>
);

/**
 * The Flows page (#755): the Catalog Roots as a sidebar, and beside it the
 * selected Flow's markdown and its Runs, each with its Run Summary. It is
 * read-only and never visible to an agent.
 */
export const FlowsPage = ({
  flow,
  onNavigate,
  run,
}: {
  /** `?flow=`: a Flow name, `@root`, or either after `global:`. */
  readonly flow: FlowsFolder | undefined;
  /** Changes `?flow=` and `?run=`; `replace` corrects the URL in place. */
  readonly onNavigate: (
    next: { readonly flow: FlowsFolder; readonly run: AgentRunId | undefined },
    options?: { readonly replace?: boolean }
  ) => void;
  /** `?run=`: the Run whose Summary the Runs pane shows. */
  readonly run: AgentRunId | undefined;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const result = useAtomValue(catalogBrowseAtom);
  const refresh = useAtomRefresh(catalogBrowseAtom);
  const origin = useAtomValue(flowsOriginAtom);
  // Each visit reads the catalog again: an agent may have saved a Flow or
  // finished a Run since it was last read.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const flows = sessionFlows(origin ?? undefined);
  const roots = result._tag === "Success" ? result.value.roots : undefined;
  const folder =
    roots === undefined
      ? undefined
      : (availableFolder(flow, roots, flows) ??
        (run === undefined ? undefined : folderOfRun(roots, run)) ??
        defaultFolder(roots, flows));
  // `/?run=<id>` lands here naming only the Run, and a folder that is gone
  // falls back to another; either way the URL comes to name what is shown.
  const settled =
    folder === undefined || (flow !== undefined && sameFolder(flow, folder));
  useEffect(() => {
    if (!settled && folder !== undefined) {
      // oxlint-disable-next-line react-doctor/no-pass-data-to-parent -- This corrects the URL, which the route owns; the folder is known only once the catalog is read.
      onNavigate({ flow: folder, run }, { replace: true });
    }
  }, [folder, onNavigate, run, settled]);

  if (result._tag === "Initial" || roots === undefined) {
    if (result._tag === "Failure") {
      return (
        <CatalogMessage>
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>The catalog could not be read</AlertTitle>
            <AlertDescription>
              <FailureText
                text={
                  refusal(result) ??
                  "This server process lists no Catalog Root."
                }
              />
            </AlertDescription>
          </Alert>
        </CatalogMessage>
      );
    }
    return (
      <CatalogMessage>
        <p className="text-muted-foreground text-sm">Reading the catalog…</p>
      </CatalogMessage>
    );
  }
  const unreadable = roots.reduce((count, root) => count + root.unreadable, 0);
  const warning =
    unreadable === 0 ? null : (
      <p
        className="island text-muted-foreground fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-xs"
        role="status"
      >
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {unreadable} catalog {unreadable === 1 ? "document" : "documents"} could
        not be read.
      </p>
    );
  const root = roots.find((entry) => entry.scope === folder?.scope);
  const select = (next: FlowsFolder) => {
    onNavigate({ flow: next, run: undefined });
  };
  if (folder === undefined || root === undefined) {
    return (
      <>
        <NoFlows />
        {warning}
      </>
    );
  }
  return (
    <>
      <Catalog flows={flows} folder={folder} onFolder={select} roots={roots} />
      <FolderPanes
        flows={flows}
        folder={folder}
        onFolder={select}
        onRun={(runId) => {
          onNavigate({ flow: folder, run: runId });
        }}
        root={root}
        runId={run}
      />
      {warning}
    </>
  );
};
