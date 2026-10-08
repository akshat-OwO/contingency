import type {
  CatalogFlowSkillEntry,
  CatalogRootView,
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
  FolderSearchIcon,
  GlobeIcon,
  HardDriveIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  SessionSkills,
  SkillsFolder,
  SkillsSessionView,
} from "@/components/catalog/skills-drawer-state";
import {
  availableFolder,
  defaultFolder,
  hasBrowsableEntries,
  looseRuns,
  matchesQuery,
  opensGlobal,
  orphanRecordings,
  recordingsForSkill,
  runCountLabel,
  runsForSkill,
  sameFolder,
  sameSelection,
  sessionSkills,
  skillsSelectionAtom,
} from "@/components/catalog/skills-drawer-state";
import {
  InlineEmpty,
  OutcomeDot,
  RecordingRow,
  RunRow,
  SectionLabel,
} from "@/components/catalog/skills-parts";
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

const SkillRow = ({
  label,
  onSelect,
  root,
  selected,
  skill,
}: {
  readonly label: string | undefined;
  readonly onSelect: () => void;
  readonly root: CatalogRootView;
  readonly selected: boolean;
  readonly skill: CatalogFlowSkillEntry;
}) => {
  const runs = runsForSkill(root, skill.name);
  const latest = runs.at(0);
  return (
    <button
      aria-pressed={selected}
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
        <span className="block truncate text-sm">{skill.name}</span>
        <span
          className={cn(
            "block truncate text-xs",
            selected ? "text-primary-foreground/70" : "text-muted-foreground"
          )}
        >
          {skill.verified ? "Verified" : "Drafted"} ·{" "}
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
      {latest === undefined ? null : <OutcomeDot outcome={latest.assessment} />}
    </button>
  );
};

/** The skill being taught has no folder yet; it holds its place anyway. */
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

const RootSkills = ({
  folder,
  onFolder,
  query,
  root,
  skills,
}: {
  readonly folder: SkillsFolder | undefined;
  readonly onFolder: (folder: SkillsFolder) => void;
  readonly query: string;
  readonly root: CatalogRootView;
  readonly skills: SessionSkills;
}) => {
  const listed = root.flowSkills.filter((skill) => matchesQuery(skill, query));
  const loose = looseRuns(root);
  const orphans = orphanRecordings(root);
  const filtering = query.trim() !== "";
  const pending =
    root.scope === "local" &&
    skills.pending !== undefined &&
    !root.flowSkills.some((skill) => skill.name === skills.pending)
      ? skills.pending
      : undefined;
  if (!root.present && pending === undefined) {
    return (
      <InlineEmpty>
        No <code>.contingency</code> folder at{" "}
        <code className="break-all">{root.path}</code>.
      </InlineEmpty>
    );
  }
  const looseFolder: SkillsFolder = { kind: "loose", scope: root.scope };
  const recordingsFolder: SkillsFolder = {
    kind: "recordings",
    scope: root.scope,
  };
  return (
    <div className="space-y-0.5">
      {pending === undefined ? null : (
        <PendingRow
          name={pending}
          onSelect={() => {
            onFolder({ kind: "skill", name: pending, scope: root.scope });
          }}
          selected={sameFolder(folder, {
            kind: "skill",
            name: pending,
            scope: root.scope,
          })}
        />
      )}
      {listed.map((skill) => {
        const target: SkillsFolder = {
          kind: "skill",
          name: skill.name,
          scope: root.scope,
        };
        return (
          <SkillRow
            key={skill.name}
            label={skills.labels.get(skill.name)}
            onSelect={() => {
              onFolder(target);
            }}
            root={root}
            selected={sameFolder(folder, target)}
            skill={skill}
          />
        );
      })}
      {listed.length === 0 &&
      pending === undefined &&
      (filtering || !hasBrowsableEntries(root)) ? (
        <InlineEmpty>
          {filtering
            ? `Nothing here matches “${query.trim()}”.`
            : "No Flow Skills here yet."}
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
          <PlayIcon aria-hidden="true" className="size-3.5" />
          <span className="flex-1">Other runs</span>
          <span className="text-xs tabular-nums">{loose.length}</span>
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
          <ClapperboardIcon aria-hidden="true" className="size-3.5" />
          <span className="flex-1">Other recordings</span>
          <span className="text-xs tabular-nums">{orphans.length}</span>
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
      aria-label="Filter skills"
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
  skills,
}: {
  readonly folder: SkillsFolder | undefined;
  readonly onFolder: (folder: SkillsFolder) => void;
  readonly query: string;
  readonly roots: readonly CatalogRootView[];
  readonly setQuery: (query: string) => void;
  readonly skills: SessionSkills;
}) => {
  const [local, global] = roots;
  const openGlobal =
    folder?.scope === "global" || opensGlobal(roots, query, skills);
  const globalHits =
    global?.flowSkills.filter((skill) => matchesQuery(skill, query)).length ??
    0;
  return (
    <section aria-label="Catalog" className="flex min-h-0 flex-col border-r">
      <div className="border-b p-1.5">
        <FilterInput query={query} setQuery={setQuery} />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1.5">
        {local === undefined ? null : (
          <section aria-label="Local skills" className="space-y-1">
            <p
              className="flex items-center gap-1.5 px-2 pt-1 text-xs font-medium"
              title={local.path}
            >
              <HardDriveIcon aria-hidden="true" className="size-3.5" />
              Local
            </p>
            <RootSkills
              folder={folder}
              onFolder={onFolder}
              query={query}
              root={local}
              skills={skills}
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
              <GlobeIcon aria-hidden="true" className="size-3.5" />
              Global
              <span className="text-muted-foreground ml-auto font-normal tabular-nums">
                {global.present ? globalHits : "none"}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1">
              <RootSkills
                folder={folder}
                onFolder={onFolder}
                query={query}
                root={global}
                skills={skills}
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
  readonly folder: SkillsFolder;
  readonly root: CatalogRootView;
}) => {
  const [selection, setSelection] = useAtom(skillsSelectionAtom);
  const historyRuns = folder.kind === "loose" ? looseRuns(root) : [];
  const historyRecordings =
    folder.kind === "recordings" ? orphanRecordings(root) : [];
  const runs =
    folder.kind === "skill" ? runsForSkill(root, folder.name) : historyRuns;
  const recordings =
    folder.kind === "skill"
      ? recordingsForSkill(root, folder.name)
      : historyRecordings;
  const skill =
    folder.kind === "skill"
      ? root.flowSkills.find((entry) => entry.name === folder.name)
      : undefined;
  return (
    <div className="space-y-3 p-1.5">
      {skill === undefined ? null : (
        <button
          aria-pressed={sameSelection(selection, {
            kind: "skill",
            name: skill.name,
            scope: root.scope,
          })}
          className="hover:bg-muted aria-pressed:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors duration-100"
          onClick={() => {
            setSelection({
              kind: "skill",
              name: skill.name,
              scope: root.scope,
            });
          }}
          type="button"
        >
          <FileTextIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5"
          />
          <span className="flex-1">SKILL.md</span>
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
              {skill?.verified === false
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
  skills,
}: {
  readonly folder: SkillsFolder | undefined;
  readonly onClearQuery: () => void;
  readonly query: string;
  readonly roots: readonly CatalogRootView[];
  readonly skills: SessionSkills;
}) => {
  const hits = roots.flatMap((root) =>
    root.flowSkills.filter((skill) => matchesQuery(skill, query))
  );
  if (query.trim() !== "" && hits.length === 0) {
    return (
      <Empty className="p-3">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No skill matches &ldquo;{query.trim()}&rdquo;</EmptyTitle>
          <EmptyDescription>
            Searched Local and Global by name.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onClearQuery} size="sm" variant="outline">
            Show all skills
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
          <EmptyDescription>Pick a skill to see its runs.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (
    folder.kind === "skill" &&
    folder.name === skills.pending &&
    !root.flowSkills.some((skill) => skill.name === folder.name)
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
              drafts <code>{folder.name}/SKILL.md</code> here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return <FolderContents folder={folder} root={root} />;
};

/** Nothing on disk in either root, and nothing being taught. */
const NoSkillsAnywhere = ({
  session,
}: {
  readonly session: SkillsSessionView | undefined;
}) => (
  <div className="min-h-0 flex-1 p-4">
    <Empty className="h-full border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BookOpenIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No Flow Skills yet</EmptyTitle>
        <EmptyDescription>
          Contingency looks in this workspace&rsquo;s <code>.contingency</code>{" "}
          and in <code>~/.contingency</code>. Neither has a skill.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <p className="text-muted-foreground text-xs">
          {session?.activity === "run"
            ? "This Run uses no skill. Teach one to rerun the journey later."
            : "Skills you teach and verify appear here."}
        </p>
      </EmptyContent>
    </Empty>
  </div>
);

/**
 * The drawer's two columns: both Catalog Roots, then the open skill's Runs
 * and Teaching Recordings. What is picked there opens beside the browser.
 */
export const SkillsDrawer = ({
  session,
}: {
  readonly session: SkillsSessionView | undefined;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const result = useAtomValue(catalogBrowseAtom);
  const refresh = useAtomRefresh(catalogBrowseAtom);
  // Each opening reads the catalog again: an agent may have saved a skill
  // or finished a Run since the drawer was last open.
  useEffect(() => {
    refresh();
  }, [refresh]);
  const [queryAtom] = useState(() => Atom.make(""));
  const [folderAtom] = useState(() => Atom.make<SkillsFolder | null>(null));
  const [query, setQuery] = useAtom(queryAtom);
  const [chosen, setChosen] = useAtom(folderAtom);
  const skills = sessionSkills(session);

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
    skills.pending === undefined
  ) {
    return (
      <>
        {warning}
        <NoSkillsAnywhere session={session} />
      </>
    );
  }
  const folder =
    availableFolder(chosen, roots, skills) ?? defaultFolder(roots, skills);
  const historyName =
    folder?.kind === "recordings" ? "Other recordings" : "Other runs";
  const folderName = folder?.kind === "skill" ? folder.name : historyName;
  return (
    <>
      {warning}
      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)]">
        <CatalogColumn
          folder={folder}
          onFolder={setChosen}
          query={query}
          roots={roots}
          setQuery={setQuery}
          skills={skills}
        />
        <section aria-label={folderName} className="flex min-h-0 flex-col">
          <h2 className="text-muted-foreground border-b px-3 py-2 text-xs font-medium tracking-wide uppercase">
            {folderName}
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ContentsColumn
              folder={folder}
              onClearQuery={() => {
                setQuery("");
              }}
              query={query}
              roots={roots}
              skills={skills}
            />
          </div>
        </section>
      </div>
    </>
  );
};
