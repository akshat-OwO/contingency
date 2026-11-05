import type { CatalogFlowEntry, CatalogRootView } from "@contingency/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ClapperboardIcon,
  FileTextIcon,
  FolderIcon,
  FolderSearchIcon,
  GlobeIcon,
  HardDriveIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type {
  SessionFlows,
  FlowsFolder,
  FlowsSessionView,
} from "@/components/catalog/flows-drawer-state";
import {
  availableFolder,
  defaultFolder,
  hasBrowsableEntries,
  looseRuns,
  matchesQuery,
  opensGlobal,
  orphanRecordings,
  recordingsForFlow,
  runCountLabel,
  runsForFlow,
  sameFolder,
  sameSelection,
  sessionFlows,
  flowsSelectionAtom,
} from "@/components/catalog/flows-drawer-state";
import {
  InlineEmpty,
  OutcomeDot,
  RecordingRow,
  RunRow,
  SectionLabel,
} from "@/components/catalog/flows-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

const FlowRow = ({
  label,
  onSelect,
  root,
  selected,
  flow,
}: {
  readonly label: string | undefined;
  readonly onSelect: () => void;
  readonly root: CatalogRootView;
  readonly selected: boolean;
  readonly flow: CatalogFlowEntry;
}) => {
  const runs = runsForFlow(root, flow.name);
  const latest = runs.at(0);
  return (
    <button
      role="treeitem"
      aria-selected={selected}
      className={cn(
        "hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100",
        selected && "bg-primary text-primary-foreground hover:bg-primary"
      )}
      onClick={onSelect}
      type="button"
    >
      <FolderIcon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          !selected && "text-muted-foreground"
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{flow.name}</span>
        <span
          className={cn(
            "block truncate text-xs",
            selected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {flow.verified ? "Verified" : "Drafted"} ·{" "}
          {runCountLabel(runs.length)}
          {label === undefined ? null : (
            <span
              className={cn(
                "font-medium",
                selected ? "text-primary-foreground" : "text-foreground"
              )}
            >
              {" "}
              · {label}
            </span>
          )}
        </span>
      </span>
      {latest === undefined ? null : <OutcomeDot run={latest} />}
    </button>
  );
};

/** The flow being taught has no folder yet; it holds its place anyway. */
const PendingRow = ({
  name,
  onSelect,
  selected,
}: {
  readonly name: string;
  readonly onSelect: () => void;
  readonly selected: boolean;
}) => (
  <button
    aria-pressed={selected}
    className={cn(
      "hover:bg-muted flex w-full items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-left transition-colors duration-100",
      selected && "bg-muted border-foreground/30"
    )}
    onClick={onSelect}
    type="button"
  >
    <CircleDashedIcon
      aria-hidden="true"
      className="text-muted-foreground size-3.5 shrink-0"
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{name}</span>
      <span className="text-muted-foreground block text-xs">
        Being taught · not saved yet
      </span>
    </span>
  </button>
);

const GroupBranch = ({
  name,
  children,
}: {
  readonly name: string;
  readonly children: React.ReactNode;
}) => {
  const groupId = useId();
  const [openAtom] = useState(() => Atom.make(true));
  const [open, setOpen] = useAtom(openAtom);
  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-label={name}
        aria-expanded={open}
        aria-owns={open ? groupId : undefined}
        className="text-muted-foreground flex w-full items-center gap-2 px-2 py-1 text-xs"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(event.key === "ArrowRight");
          }
        }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3.5", open && "rotate-90")}
        />
        {name}
      </button>
      {open ? (
        <ul id={groupId} role="group" className="ml-3 border-l pl-1">
          {children}
        </ul>
      ) : null}
    </li>
  );
};

/** Groups retain their directory hierarchy; Flow identity stays its name. */
const GroupTree = ({
  entries,
  depth = 0,
  renderFlow,
}: {
  readonly entries: readonly CatalogFlowEntry[];
  readonly depth?: number;
  readonly renderFlow: (flow: CatalogFlowEntry) => React.ReactNode;
}) => {
  const groups = [
    ...new Set(entries.flatMap((flow) => flow.groupPath?.[depth] ?? [])),
  ].toSorted();
  return (
    <>
      {groups.map((group) => (
        <GroupBranch name={group} key={group}>
          <GroupTree
            entries={entries.filter((flow) => flow.groupPath[depth] === group)}
            depth={depth + 1}
            renderFlow={renderFlow}
          />
        </GroupBranch>
      ))}
      {entries.flatMap((flow) =>
        flow.groupPath.length === depth
          ? [
              <li role="none" key={flow.name}>
                {renderFlow(flow)}
              </li>,
            ]
          : []
      )}
    </>
  );
};

const RootFlows = ({
  folder,
  onFolder,
  query,
  root,
  flows,
}: {
  readonly folder: FlowsFolder | undefined;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly query: string;
  readonly root: CatalogRootView;
  readonly flows: SessionFlows;
}) => {
  const listed = root.flows.filter((flow) => matchesQuery(flow, query));
  const loose = looseRuns(root);
  const orphans = orphanRecordings(root);
  const filtering = query.trim() !== "";
  const pending =
    root.scope === "local" &&
    flows.pending !== undefined &&
    !root.flows.some((flow) => flow.name === flows.pending)
      ? flows.pending
      : undefined;
  if (!root.present && pending === undefined) {
    return (
      <InlineEmpty>
        No <code>contingency</code> folder at{" "}
        <code className="break-all">{root.path}</code>.
      </InlineEmpty>
    );
  }
  const looseFolder: FlowsFolder = { kind: "loose", scope: root.scope };
  const recordingsFolder: FlowsFolder = {
    kind: "recordings",
    scope: root.scope,
  };
  return (
    <div className="space-y-0.5">
      {pending === undefined ? null : (
        <PendingRow
          name={pending}
          onSelect={() => {
            onFolder({ kind: "flow", name: pending, scope: root.scope });
          }}
          selected={sameFolder(folder, {
            kind: "flow",
            name: pending,
            scope: root.scope,
          })}
        />
      )}
      <ul
        role="tree"
        aria-label={`${root.scope} Flow Groups`}
        onKeyDown={(event) => {
          const tree = event.currentTarget;
          const items = [...tree.querySelectorAll<HTMLButtonElement>("button")];
          const active = document.activeElement;
          const index =
            active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
          let target: HTMLButtonElement | undefined;
          if (event.key === "ArrowDown") {
            target = items[index + 1];
          }
          if (event.key === "ArrowUp") {
            target = items[index - 1];
          }
          if (event.key === "Home") {
            target = items.at(0);
          }
          if (event.key === "End") {
            target = items.at(-1);
          }
          if (target !== undefined) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <GroupTree
          entries={listed}
          renderFlow={(flow) => {
            const target: FlowsFolder = {
              kind: "flow",
              name: flow.name,
              scope: root.scope,
            };
            return (
              <FlowRow
                key={flow.name}
                label={flows.labels.get(flow.name)}
                onSelect={() => {
                  onFolder(target);
                }}
                root={root}
                selected={sameFolder(folder, target)}
                flow={flow}
              />
            );
          }}
        />
      </ul>
      {listed.length === 0 &&
      pending === undefined &&
      (filtering || !hasBrowsableEntries(root)) ? (
        <InlineEmpty>
          {filtering
            ? `Nothing here matches “${query.trim()}”.`
            : "No Flows here yet."}
        </InlineEmpty>
      ) : null}
      {loose.length === 0 || filtering ? null : (
        <button
          aria-pressed={sameFolder(folder, looseFolder)}
          className={cn(
            "hover:bg-muted text-muted-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
            sameFolder(folder, looseFolder) && "bg-muted text-foreground"
          )}
          onClick={() => {
            onFolder(looseFolder);
          }}
          type="button"
        >
          <PlayIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 wrap-anywhere">Root Runs</span>
          <span className="shrink-0 text-xs tabular-nums">{loose.length}</span>
        </button>
      )}
      {orphans.length === 0 || filtering ? null : (
        <button
          aria-pressed={sameFolder(folder, recordingsFolder)}
          className={cn(
            "hover:bg-muted text-muted-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
            sameFolder(folder, recordingsFolder) && "bg-muted text-foreground"
          )}
          onClick={() => {
            onFolder(recordingsFolder);
          }}
          type="button"
        >
          <ClapperboardIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 wrap-anywhere">Other recordings</span>
          <span className="shrink-0 text-xs tabular-nums">
            {orphans.length}
          </span>
        </button>
      )}
    </div>
  );
};

const FilterInput = ({
  query,
  setQuery,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
}) => (
  <InputGroup className="h-8">
    <InputGroupAddon>
      <SearchIcon aria-hidden="true" />
    </InputGroupAddon>
    <InputGroupInput
      aria-label="Filter flows"
      onChange={(event) => {
        setQuery(event.target.value);
      }}
      placeholder="Filter"
      value={query}
    />
    {query === "" ? null : (
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          aria-label="Clear filter"
          onClick={() => {
            setQuery("");
          }}
          size="icon-xs"
        >
          <XIcon aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    )}
  </InputGroup>
);

const CatalogColumn = ({
  folder,
  onFolder,
  query,
  roots,
  setQuery,
  flows,
}: {
  readonly folder: FlowsFolder | undefined;
  readonly onFolder: (folder: FlowsFolder) => void;
  readonly query: string;
  readonly roots: readonly CatalogRootView[];
  readonly setQuery: (query: string) => void;
  readonly flows: SessionFlows;
}) => {
  const [local, global] = roots;
  const openGlobal =
    folder?.scope === "global" || opensGlobal(roots, query, flows);
  const globalHistoryHits =
    global === undefined || query.trim() !== ""
      ? 0
      : looseRuns(global).length + orphanRecordings(global).length;
  const globalHits =
    (global?.flows.filter((flow) => matchesQuery(flow, query)).length ?? 0) +
    globalHistoryHits;
  return (
    <section aria-label="Catalog" className="flex min-h-0 min-w-0 flex-col">
      <div className="border-b p-1.5">
        <FilterInput query={query} setQuery={setQuery} />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1.5">
        {local === undefined ? null : (
          <section aria-label="Local flows" className="space-y-1">
            <p
              className="flex items-center gap-1.5 px-2 pt-1 text-xs font-medium"
              title={local.path}
            >
              <HardDriveIcon aria-hidden="true" className="size-3.5 shrink-0" />
              Local
            </p>
            <RootFlows
              folder={folder}
              onFolder={onFolder}
              query={query}
              root={local}
              flows={flows}
            />
          </section>
        )}
        {global === undefined ? null : (
          <Collapsible
            className="border-t pt-2"
            defaultOpen={openGlobal}
            key={`global-${String(openGlobal)}`}
          >
            <CollapsibleTrigger
              className="group/global hover:bg-muted flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium"
              title={global.path}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className="text-muted-foreground size-3.5 transition-transform duration-150 group-data-panel-open/global:rotate-90"
              />
              <GlobeIcon aria-hidden="true" className="size-3.5 shrink-0" />
              Global
              <span className="text-muted-foreground ml-auto font-normal tabular-nums">
                {global.present ? globalHits : 0}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1">
              <RootFlows
                folder={folder}
                onFolder={onFolder}
                query={query}
                root={global}
                flows={flows}
              />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
};

const FolderContents = ({
  folder,
  root,
}: {
  readonly folder: FlowsFolder;
  readonly root: CatalogRootView;
}) => {
  const [selection, setSelection] = useAtom(flowsSelectionAtom);
  const historyRuns = folder.kind === "loose" ? looseRuns(root) : [];
  const historyRecordings =
    folder.kind === "recordings" ? orphanRecordings(root) : [];
  const runs =
    folder.kind === "flow" ? runsForFlow(root, folder.name) : historyRuns;
  const recordings =
    folder.kind === "flow"
      ? recordingsForFlow(root, folder.name)
      : historyRecordings;
  const flow =
    folder.kind === "flow"
      ? root.flows.find((entry) => entry.name === folder.name)
      : undefined;
  return (
    <div className="space-y-3 p-1.5">
      {flow === undefined ? null : (
        <button
          aria-pressed={sameSelection(selection, {
            kind: "flow",
            name: flow.name,
            scope: root.scope,
          })}
          className="hover:bg-muted aria-pressed:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-100"
          onClick={() => {
            setSelection({
              kind: "flow",
              name: flow.name,
              scope: root.scope,
            });
          }}
          type="button"
        >
          <FileTextIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5"
          />
          <span className="flex-1">flow.md</span>
          <ChevronRightIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5"
          />
        </button>
      )}
      {folder.kind === "recordings" ? null : (
        <div>
          <SectionLabel>Runs · {runs.length}</SectionLabel>
          {runs.length === 0 ? (
            <InlineEmpty>
              Not run yet.{" "}
              {flow?.verified === false
                ? "A passing Dry Run is the next step."
                : "Ask your agent to run it."}
            </InlineEmpty>
          ) : (
            runs.map((run) => {
              const target = { kind: "run", run, scope: root.scope } as const;
              return (
                <RunRow
                  key={run.runId}
                  onSelect={() => {
                    setSelection(target);
                  }}
                  run={run}
                  selected={sameSelection(selection, target)}
                />
              );
            })
          )}
        </div>
      )}
      {recordings.length === 0 ? null : (
        <div>
          <SectionLabel>Teaching Recordings · {recordings.length}</SectionLabel>
          {recordings.map((recording) => {
            const target = {
              kind: "recording",
              recording,
              scope: root.scope,
            } as const;
            return (
              <RecordingRow
                key={recording.recordingId}
                onSelect={() => {
                  setSelection(target);
                }}
                recording={recording}
                selected={sameSelection(selection, target)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

const ContentsColumn = ({
  folder,
  onClearQuery,
  query,
  roots,
  flows,
}: {
  readonly folder: FlowsFolder | undefined;
  readonly onClearQuery: () => void;
  readonly query: string;
  readonly roots: readonly CatalogRootView[];
  readonly flows: SessionFlows;
}) => {
  const hits = roots.flatMap((root) =>
    root.flows.filter((flow) => matchesQuery(flow, query))
  );
  if (query.trim() !== "" && hits.length === 0) {
    return (
      <Empty className="p-3">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No flow matches &ldquo;{query.trim()}&rdquo;</EmptyTitle>
          <EmptyDescription>
            Searched Local and Global by name.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onClearQuery} size="sm" variant="outline">
            Show all flows
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const root = roots.find((entry) => entry.scope === folder?.scope);
  if (folder === undefined || root === undefined) {
    return (
      <Empty className="p-3">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderSearchIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyDescription>Pick a flow to see its runs.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (
    folder.kind === "flow" &&
    folder.name === flows.pending &&
    !root.flows.some((flow) => flow.name === folder.name)
  ) {
    return (
      <div className="p-3">
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleDashedIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Not saved yet</EmptyTitle>
            <EmptyDescription>
              After you stop recording, the agent learns the recording and
              drafts{" "}
              <code className="wrap-anywhere">{folder.name}/flow.md</code> here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return <FolderContents folder={folder} root={root} />;
};

/** Nothing on disk in either root, and nothing being taught. */
const NoFlowsAnywhere = ({
  session,
}: {
  readonly session: FlowsSessionView | undefined;
}) => (
  <div className="min-h-0 flex-1 p-4">
    <Empty className="h-full border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpenIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No Flows yet</EmptyTitle>
        <EmptyDescription>
          Contingency looks in this workspace&rsquo;s <code>contingency</code>{" "}
          and in <code>~/.contingency</code>. Neither has a flow.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-xs">
          {session?.activity === "run"
            ? "This Run uses no flow. Teach one to rerun the journey later."
            : "Flows you teach and verify appear here."}
        </p>
      </EmptyContent>
    </Empty>
  </div>
);

/** Selection survives switching between the two narrow navigation views. */
const FlowsNavigation = ({
  roots,
  flows,
}: {
  readonly roots: readonly CatalogRootView[];
  readonly flows: SessionFlows;
}) => {
  const [queryAtom] = useState(() => Atom.make(""));
  const [folderAtom] = useState(() => Atom.make<FlowsFolder | null>(null));
  const [viewAtom] = useState(() =>
    Atom.make<"catalog" | "contents">("catalog")
  );
  const [narrowAtom] = useState(() => Atom.make(true));
  const [query, setQuery] = useAtom(queryAtom);
  const [chosen, setChosen] = useAtom(folderAtom);
  const [view, setView] = useAtom(viewAtom);
  const [narrow, setNarrow] = useAtom(narrowAtom);
  const breakpointRef = useRef<HTMLSpanElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterChange = useRef(false);

  useLayoutEffect(() => {
    const breakpoint = breakpointRef.current;
    if (breakpoint === null) {
      return;
    }
    // CSS owns the root-relative container query. Observing its probe also
    // reacts to enlarged text without a viewport breakpoint or polling.
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) {
        return;
      }
      const nextNarrow = entry.contentRect.width === 0;
      const active = document.activeElement;
      if (nextNarrow && navigationRef.current?.contains(active)) {
        const inCatalog = active?.closest('[aria-label="Catalog"]') !== null;
        setView(inCatalog ? "catalog" : "contents");
        focusAfterChange.current = true;
      }
      setNarrow(nextNarrow);
    });
    observer.observe(breakpoint);
    return () => {
      observer.disconnect();
    };
  }, [setNarrow, setView]);

  useLayoutEffect(() => {
    if (!focusAfterChange.current) {
      return;
    }
    focusAfterChange.current = false;
    if (view === "contents") {
      headingRef.current?.focus({ preventScroll: true });
      return;
    }
    const catalog = navigationRef.current?.querySelector(
      '[aria-label="Catalog"]'
    );
    const target =
      catalog?.querySelector<HTMLElement>(
        'button[aria-selected="true"], button[aria-pressed="true"]'
      ) ?? catalog?.querySelector<HTMLElement>("input");
    target?.focus({ preventScroll: true });
  }, [narrow, view]);

  const folder =
    availableFolder(chosen, roots, flows) ?? defaultFolder(roots, flows);
  const historyName =
    folder?.kind === "recordings" ? "Other recordings" : "Root Runs";
  const folderName = folder?.kind === "flow" ? folder.name : historyName;
  return (
    <div className="@container/flows relative flex min-h-0 min-w-0 flex-1 flex-col">
      <span
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-px w-0 @min-[40rem]/flows:w-px"
        ref={breakpointRef}
      />
      <div
        className={cn(
          "grid min-h-0 min-w-0 flex-1",
          !narrow && "grid-cols-[14rem_minmax(0,1fr)] divide-x"
        )}
        ref={navigationRef}
      >
        {!narrow || view === "catalog" ? (
          <CatalogColumn
            folder={folder}
            onFolder={(target) => {
              setChosen(target);
              setView("contents");
              if (narrow) {
                focusAfterChange.current = true;
              }
            }}
            query={query}
            roots={roots}
            setQuery={setQuery}
            flows={flows}
          />
        ) : null}
        {!narrow || view === "contents" ? (
          <section
            aria-label={folderName}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {narrow ? (
              <Button
                className="h-auto justify-start rounded-none border-b px-3 py-2 whitespace-normal"
                onClick={() => {
                  focusAfterChange.current = true;
                  setView("catalog");
                }}
                variant="ghost"
              >
                <ArrowLeftIcon aria-hidden="true" />
                Back to catalog
              </Button>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <h2
                className="text-muted-foreground border-b px-3 py-2 text-xs font-medium tracking-wide wrap-anywhere uppercase"
                ref={headingRef}
                tabIndex={-1}
              >
                {folderName}
              </h2>
              <ContentsColumn
                folder={folder}
                onClearQuery={() => {
                  setQuery("");
                }}
                query={query}
                roots={roots}
                flows={flows}
              />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Read-only Catalog Roots and their contents. Details open beside the browser.
 */
export const FlowsDrawer = ({
  session,
}: {
  readonly session: FlowsSessionView | undefined;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const result = useAtomValue(catalogBrowseAtom);
  const refresh = useAtomRefresh(catalogBrowseAtom);
  // Each opening reads the catalog again: an agent may have saved a flow
  // or finished a Run since the drawer was last open.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const flows = sessionFlows(session);

  if (result._tag === "Initial") {
    return (
      <p className="text-muted-foreground p-4 text-sm">Reading the catalog…</p>
    );
  }
  if (result._tag === "Failure") {
    return (
      <Alert className="m-3" variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>The catalog could not be read</AlertTitle>
        <AlertDescription>
          {refusal(result) ?? "This server process lists no Catalog Root."}
        </AlertDescription>
      </Alert>
    );
  }
  const { roots } = result.value;
  const unreadable = roots.reduce((count, root) => count + root.unreadable, 0);
  const warning =
    unreadable === 0 ? null : (
      <p
        className="text-muted-foreground m-3 flex items-start gap-2 text-xs"
        role="status"
      >
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>
          {unreadable} catalog {unreadable === 1 ? "document" : "documents"}{" "}
          could not be read.
        </span>
      </p>
    );
  if (
    roots.every((root) => !hasBrowsableEntries(root)) &&
    flows.pending === undefined
  ) {
    return (
      <>
        {warning}
        <NoFlowsAnywhere session={session} />
      </>
    );
  }
  return (
    <>
      {warning}
      <FlowsNavigation roots={roots} flows={flows} />
    </>
  );
};
