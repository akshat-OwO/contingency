import type {
  CatalogFlowResult,
  CatalogRecordingEntry,
  CatalogRootScope,
  CatalogRunEntry,
  FlowName,
} from "@contingency/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createHighlighter } from "@tanstack/highlight/core";
import { markdown } from "@tanstack/highlight/languages/markdown";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import {
  CircleAlertIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  HardDriveIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { EvidenceReference } from "@/components/agent/evidence-reference";
import { HighlightedCode } from "@/components/browser/highlighted-code";
import type { FlowsSelection } from "@/components/catalog/flows-drawer-state";
import { flowsSelectionAtom } from "@/components/catalog/flows-drawer-state";
import {
  recordingPhaseLabel,
  runDuration,
  runKindLabel,
  runVerdict,
  stepInstruction,
  when,
} from "@/components/catalog/flows-format";
import { OutcomeDot } from "@/components/catalog/flows-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { refusal } from "@/lib/refusal";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const highlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: [markdown, plaintext],
});

const Section = ({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) => (
  <section aria-label={title} className="space-y-2">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      {title}
    </h3>
    {children}
  </section>
);

const ScopeBadge = ({ scope }: { readonly scope: CatalogRootScope }) => (
  <Badge variant="outline">
    {scope === "local" ? (
      <HardDriveIcon data-icon="inline-start" />
    ) : (
      <GlobeIcon data-icon="inline-start" />
    )}
    {scope === "local" ? "Local" : "Global"}
  </Badge>
);

/** A flow name that opens that flow's package in the same panel. */
const FlowLink = ({
  name,
  scope,
}: {
  readonly name: FlowName;
  readonly scope: CatalogRootScope;
}) => {
  const { catalogBrowseAtom } = useRpcDependencies();
  const select = useAtomSet(flowsSelectionAtom);
  const result = useAtomValue(catalogBrowseAtom);
  const listed =
    result._tag === "Success" &&
    result.value.roots.some(
      (root) =>
        root.scope === scope && root.flows.some((flow) => flow.name === name)
    );
  // A Run can name a flow this root no longer holds, or a bundled Example
  // that was never in it; that name is shown, not offered as a link.
  if (!listed) {
    return (
      <Badge title="Not in this Catalog Root" variant="ghost">
        {name}
      </Badge>
    );
  }
  return (
    <Badge
      render={
        <button
          onClick={() => {
            select({ kind: "flow", name, scope });
          }}
          type="button"
        />
      }
      variant="outline"
    >
      {name}
    </Badge>
  );
};

const FlowPackage = ({
  scope,
  flow,
}: {
  readonly scope: CatalogRootScope;
  readonly flow: CatalogFlowResult;
}) => (
  <article className="space-y-5">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {flow.entry.verified ? (
          <Badge variant="secondary">
            <ShieldCheckIcon data-icon="inline-start" />
            Verified
          </Badge>
        ) : (
          <Badge variant="outline">Drafted</Badge>
        )}
        <ScopeBadge scope={scope} />
        {flow.entry.demo === undefined ? null : (
          <Badge variant="outline">Demo site</Badge>
        )}
      </div>
      <h2 className="text-lg font-semibold tracking-tight">
        {flow.entry.name}
      </h2>
      <p className="text-muted-foreground text-sm">{flow.entry.description}</p>
      {flow.entry.hosts.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {flow.entry.hosts.map((host) => (
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs" key={host}>
              {host}
            </code>
          ))}
        </div>
      )}
    </header>
    <Tabs defaultValue="procedure">
      <TabsList variant="line">
        <TabsTrigger value="procedure">Procedure</TabsTrigger>
        <TabsTrigger value="files">Files · {flow.files.length}</TabsTrigger>
      </TabsList>
      <TabsContent className="pt-3" value="procedure">
        {flow.steps.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This flow.md has no numbered procedure.
          </p>
        ) : (
          <ol className="space-y-4">
            {flow.steps.map((step, index) => (
              <li
                className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2"
                key={step.description}
              >
                <span className="text-muted-foreground text-sm tabular-nums">
                  {index + 1}.
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm leading-6 wrap-anywhere">
                    {stepInstruction(step.description)}
                  </p>
                  {step.doneWhen === "" ? null : (
                    <p className="border-l-2 border-emerald-500/50 pl-2 text-xs leading-5 wrap-anywhere">
                      <span className="font-medium">Done when:</span>{" "}
                      <span className="text-muted-foreground">
                        {step.doneWhen}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </TabsContent>
      <TabsContent className="space-y-3 pt-3" value="files">
        {flow.files.map((file) => (
          <div className="overflow-hidden rounded-lg border" key={file.path}>
            <p className="bg-muted/40 text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
              <FileTextIcon aria-hidden="true" className="size-3.5" />
              {file.path}
            </p>
            <div className="max-h-96 overflow-auto">
              <HighlightedCode
                tokens={
                  highlighter.tokenize(file.content, { lang: "markdown" })
                    .tokens
                }
              />
            </div>
          </div>
        ))}
      </TabsContent>
    </Tabs>
  </article>
);

const FlowDetail = ({
  name,
  scope,
}: {
  readonly name: FlowName;
  readonly scope: CatalogRootScope;
}) => {
  const { catalogFlowAtom } = useRpcDependencies();
  const result = useAtomValue(catalogFlowAtom(scope)(name));
  if (result._tag === "Initial") {
    return <p className="text-muted-foreground text-sm">Reading flow.md…</p>;
  }
  if (result._tag === "Failure") {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>This flow could not be read</AlertTitle>
        <AlertDescription>
          {refusal(result) ?? "Its flow.md is no longer there."}
        </AlertDescription>
      </Alert>
    );
  }
  return <FlowPackage scope={scope} flow={result.value} />;
};

const RunDetail = ({
  run,
  scope,
}: {
  readonly run: CatalogRunEntry;
  readonly scope: CatalogRootScope;
}) => (
  <article className="space-y-5">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant={
            run.assessment === "not-working" ? "destructive" : "secondary"
          }
        >
          <OutcomeDot run={run} />
          {runVerdict(run)}
        </Badge>
        <Badge variant="outline">{runKindLabel(run)}</Badge>
        <ScopeBadge scope={scope} />
      </div>
      <h2 className="text-base leading-snug font-semibold">{run.title}</h2>
      <p className="text-muted-foreground text-xs">
        {when(run.startedAt)} · {runDuration(run)}
      </p>
      <EvidenceReference id={run.runId} kind="Run ID" />
    </header>
    <Section title="Flows">
      {run.flowNames.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This Run referenced no Flow.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {run.flowNames.map((name) => (
            <FlowLink key={name} name={name} scope={scope} />
          ))}
        </div>
      )}
    </Section>
    {/*
      The read-only viewer reads this process's own Run store, so it opens
      local Interactive Runs. A Dry Run's evidence lives with its recording,
      and a global Run belongs to another Catalog Root.
    */}
    {scope === "local" && run.kind !== "dry-run" ? (
      <a
        className={buttonVariants({ size: "sm", variant: "outline" })}
        href={`/?run=${run.runId}`}
        rel="noreferrer"
        target="_blank"
      >
        <ExternalLinkIcon aria-hidden="true" />
        Open Run Summary
      </a>
    ) : (
      <p className="text-muted-foreground text-xs text-pretty">
        {run.kind === "dry-run"
          ? "A Dry Run's evidence stays with its recording. Copy the Run ID above and ask your agent to open that Run."
          : "This Run belongs to another Catalog Root. Open it from a Workspace that uses that root."}
      </p>
    )}
  </article>
);

const RecordingDetail = ({
  recording,
  scope,
}: {
  readonly recording: CatalogRecordingEntry;
  readonly scope: CatalogRootScope;
}) => (
  <article className="space-y-5">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">
          <CircleDashedIcon data-icon="inline-start" />
          Teaching Recording
        </Badge>
        <Badge variant="secondary">{recordingPhaseLabel(recording)}</Badge>
      </div>
      <h2 className="font-mono text-sm font-semibold break-all">
        {recording.recordingId}
      </h2>
      <p className="text-muted-foreground text-xs">
        Taught {when(recording.createdAt)} · {recording.keyframeCount} keyframes
      </p>
    </header>
    <Section title="Flow">
      <FlowLink name={recording.flowName} scope={scope} />
    </Section>
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {recording.cleanup === "purged"
        ? "Cleanup removed the video, Trace, and events after verification. Only the manifest is left."
        : "Sensitive learning evidence. Cleanup deletes it once the Flow is verified."}
    </p>
  </article>
);

/** The details panel beside the browser, for whatever the drawer picked. */
export const FlowDetails = ({
  selection,
}: {
  readonly selection: FlowsSelection;
}) => {
  if (selection.kind === "flow") {
    return <FlowDetail name={selection.name} scope={selection.scope} />;
  }
  if (selection.kind === "run") {
    return <RunDetail run={selection.run} scope={selection.scope} />;
  }
  return (
    <RecordingDetail recording={selection.recording} scope={selection.scope} />
  );
};
