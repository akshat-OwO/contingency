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
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ClapperboardIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  PlayIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { EvidenceReference } from "@/components/agent/evidence-reference";
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
  FlowsFolder,
  SessionFlows,
} from "@/components/catalog/flows-page-state";
import {
  availableFolder,
  defaultFolder,
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
import { OutcomeDot } from "@/components/catalog/flows-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const TreeRows = ({
  labels,
  nodes,
}: {
  readonly labels: ReadonlyMap<string, string>;
  readonly nodes: readonly TreeNode[];
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
            <FileTextIcon
              aria-hidden="true"
              className="text-muted-foreground ml-[22px] size-[15px] shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">{node.flow.name}</span>{" "}
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
          <TreeRows labels={labels} nodes={node.children} />
        </TreeGroup>
      ) : null}
    </TreeItem>
  ));

const rowButton =
  "hover:bg-island-hover flex min-h-8 w-full items-center gap-2 rounded-[10px] px-2 text-left text-[13.5px] aria-pressed:bg-brand/14 aria-pressed:ring-1 aria-pressed:ring-brand/30 aria-pressed:ring-inset focus-visible:outline-2 focus-visible:outline-brand focus-visible:-outline-offset-2";

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
        <button
          aria-pressed={sameFolder(folder, {
            kind: "flow",
            name: pending,
            scope: "local",
          })}
          className={cn(rowButton, "border border-dashed")}
          onClick={() => {
            onFolder({ kind: "flow", name: pending, scope: "local" });
          }}
          type="button"
        >
          <CircleDashedIcon
            aria-hidden="true"
            className="text-muted-foreground size-[15px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{pending}</span>{" "}
          <span className="text-muted-foreground text-xs">Being taught</span>
        </button>
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
          <TreeRows labels={flows.labels} nodes={nodes} />
        </Tree>
      )}
      {history === 0 || filtering ? null : (
        <button
          aria-pressed={sameFolder(folder, rootFolder)}
          className={cn(rowButton, "mt-1")}
          onClick={() => {
            onFolder(rootFolder);
          }}
          type="button"
        >
          <PlayIcon
            aria-hidden="true"
            className="text-muted-foreground size-[15px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">Runs without one Flow</span>{" "}
          <span className="text-muted-foreground font-mono text-xs tabular-nums">
            {history}
          </span>
        </button>
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
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {count}
        </span>
        {global === undefined ? null : (
          <Button
            aria-pressed={showGlobal}
            className="text-muted-foreground hover:text-foreground aria-pressed:bg-brand/14 aria-pressed:text-foreground ml-auto h-[26px] gap-1.5 rounded-lg px-2 text-xs"
            onClick={() => {
              setShowGlobal(!showGlobal);
            }}
            size="xs"
            title={global.path}
            type="button"
            variant="outline"
          >
            <GlobeIcon aria-hidden="true" />
            Global
          </Button>
        )}
      </div>
      <label className="bg-island-hover ring-island-border focus-within:ring-brand mx-0.5 mb-2 flex h-[34px] items-center gap-2 rounded-xl px-2.5 ring-1 ring-inset focus-within:ring-[1.5px]">
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground size-[15px] shrink-0"
        />
        <Input
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
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "ready";
}) => (
  <span
    className={cn(
      "status-chip [&_svg]:size-3.5",
      tone === "neutral" && "[--status-tone:var(--muted-foreground)]"
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
          {refusal(result) ?? "Its flow.md is no longer there."}
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
  scope,
}: {
  /** Absent while the Flow is still being taught. */
  readonly flow: CatalogFlowEntry | undefined;
  readonly name: string;
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
          {scope === "global" ? (
            <Chip>
              <GlobeIcon aria-hidden="true" />
              Global
            </Chip>
          ) : null}
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
const CatalogRunSummary = ({
  note,
  onFolder,
  run,
  scope,
}: {
  readonly note: ReactNode;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => {
  const findings = run.findings ?? [];
  return (
    <section aria-label="Run Summary" className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="status-chip [--status-tone:var(--muted-foreground)]">
          <OutcomeDot run={run} />
          {runVerdict(run)}
        </span>
        <span className="text-muted-foreground text-xs">
          {runKindLabel(run)} · {when(run.startedAt)} · {runDuration(run)}
        </span>
      </div>
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
const StoredRunSummary = ({
  onFolder,
  run,
}: {
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
  return <RunSummaryView heading={false} summary={result.value.summary} />;
};

const RunSummary = ({
  onFolder,
  run,
  scope,
}: {
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => {
  let body: ReactNode;
  if (scope === "global") {
    body = (
      <CatalogRunSummary
        note="This Run is stored in ~/.contingency. Its video and evidence open only in a Workspace serving that root."
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  } else if (run.native === undefined) {
    body = <StoredRunSummary onFolder={onFolder} run={run} />;
  } else {
    body = (
      <CatalogRunSummary
        note={
          <>
            Its video and device evidence are in its{" "}
            <a
              className="text-foreground font-medium underline underline-offset-2"
              href={`/?${run.native.platform}=${run.native.sessionId}`}
            >
              device session
            </a>
            .
          </>
        }
        onFolder={onFolder}
        run={run}
        scope={scope}
      />
    );
  }
  // Both summaries name themselves "Run Summary", so the pane adds no landmark.
  return <div className="grid grid-cols-[minmax(0,1fr)] gap-3">{body}</div>;
};

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
    <h3 className="font-mono text-sm font-semibold break-all">
      {recording.recordingId}
    </h3>
    <p className="bg-island-hover rounded-xl px-3 py-2.5 text-pretty">
      {recording.cleanup === "purged"
        ? "Cleanup removed the video, Trace and events after the Flow was verified. Only the manifest is left."
        : "Sensitive learning evidence. Cleanup deletes it once you verify the Flow, after a passing Dry Run."}
    </p>
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
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {runs}
        </span>
      </header>
      {missingRun === undefined ? null : <MissingRun runId={missingRun} />}
      {entries.length === 0 ? (
        <div className="text-muted-foreground grid flex-1 place-content-center justify-items-center gap-2.5 p-6 text-center text-balance">
          <PlayIcon aria-hidden="true" className="size-5" />
          <p className="max-w-[280px]">{emptyNote}</p>
        </div>
      ) : (
        <>
          <ul
            aria-label="Runs and recordings"
            className="border-island-border grid max-h-[34%] shrink-0 gap-0.5 overflow-y-auto border-b p-2"
          >
            {entries.map((entry) => (
              <li key={entryId(entry)}>
                <button
                  aria-pressed={
                    shown !== undefined && entryId(shown) === entryId(entry)
                  }
                  className="hover:bg-island-hover aria-pressed:bg-island-hover aria-pressed:ring-island-border focus-visible:outline-brand grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl py-[7px] pr-2.5 pl-2 text-left focus-visible:outline-2 aria-pressed:ring-1 aria-pressed:ring-inset"
                  onClick={() => {
                    onShow(entry);
                  }}
                  type="button"
                >
                  {entry.kind === "run" ? (
                    <>
                      <span className="flex min-w-0 items-start gap-2.5">
                        <OutcomeDot className="mt-1.5" run={entry.run} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm">
                            {entry.run.title}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            <span className="text-foreground/80 font-medium">
                              {runVerdict(entry.run)}
                            </span>{" "}
                            · {runKindLabel(entry.run)} ·{" "}
                            {when(entry.run.startedAt)}
                          </span>
                        </span>
                      </span>
                      <span className="text-muted-foreground font-mono text-xs">
                        {runDuration(entry.run)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex min-w-0 items-start gap-2.5">
                        <ClapperboardIcon
                          aria-hidden="true"
                          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-xs">
                            {entry.recording.recordingId}
                          </span>
                          <span className="text-muted-foreground block truncate text-xs">
                            {recordingPhaseLabel(entry.recording)} · Teaching ·{" "}
                            {when(entry.recording.createdAt)}
                          </span>
                        </span>
                      </span>
                      <span />
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">
            {shown?.kind === "run" ? (
              <RunSummary
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
        <FlowPane flow={flow} name={folder.name} scope={folder.scope} />
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
              {refusal(result) ?? "This server process lists no Catalog Root."}
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
