import type {
  AgentAssessmentOutcome,
  CatalogRecordingEntry,
  CatalogRunEntry,
} from "@contingency/protocol";
import { ClapperboardIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  recordingPhaseLabel,
  runDuration,
  runKindLabel,
  when,
} from "@/components/catalog/skills-format";
import { cn } from "@/lib/utils";

const outcomeDot: Record<AgentAssessmentOutcome | "none", string> = {
  blocked: "bg-amber-500",
  inconclusive: "bg-muted-foreground",
  none: "bg-muted-foreground/40",
  "not-working": "bg-destructive",
  working: "bg-emerald-500",
};

/** A Run's health at a glance: its Agent Assessment, or grey without one. */
export const OutcomeDot = ({
  className,
  outcome,
}: {
  readonly className?: string;
  readonly outcome: AgentAssessmentOutcome | null;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "size-2 shrink-0 rounded-full",
      outcomeDot[outcome ?? "none"],
      className
    )}
  />
);

const rowClass = (selected: boolean) =>
  cn(
    "hover:bg-muted flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-100",
    selected && "bg-muted"
  );

export const RunRow = ({
  onSelect,
  run,
  selected,
}: {
  readonly onSelect: () => void;
  readonly run: CatalogRunEntry;
  readonly selected: boolean;
}) => (
  <button
    aria-pressed={selected}
    className={rowClass(selected)}
    onClick={onSelect}
    type="button"
  >
    <OutcomeDot className="mt-1.5" outcome={run.assessment} />
    <span className="min-w-0 flex-1">
      <span className="line-clamp-2 text-sm">{run.title}</span>
      <span className="text-muted-foreground block text-xs">
        {runKindLabel(run)} · {when(run.startedAt)} · {runDuration(run)}
      </span>
    </span>
  </button>
);

export const RecordingRow = ({
  onSelect,
  recording,
  selected,
}: {
  readonly onSelect: () => void;
  readonly recording: CatalogRecordingEntry;
  readonly selected: boolean;
}) => (
  <button
    aria-pressed={selected}
    className={rowClass(selected)}
    onClick={onSelect}
    type="button"
  >
    <ClapperboardIcon
      aria-hidden="true"
      className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-mono text-xs">
        {recording.recordingId}
      </span>
      <span className="text-muted-foreground block text-xs">
        {recordingPhaseLabel(recording)} · {when(recording.createdAt)}
      </span>
    </span>
  </button>
);

export const InlineEmpty = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-muted-foreground rounded-md border border-dashed px-2.5 py-2 text-xs leading-5">
    {children}
  </p>
);

export const SectionLabel = ({
  children,
}: {
  readonly children: ReactNode;
}) => (
  <p className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs">{children}</p>
);
