import type {
  AgentSessionController,
  AgentSessionPhase,
  AgentSessionId,
  AgentSessionSnapshot,
  TeachingCaptureState,
  TeachingInstruction,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";
import { useAtomValue } from "@effect/atom-react";
import {
  CircleAlertIcon,
  CheckIcon,
  MessageSquareTextIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  commentComposerOpenAtom,
  sessionWaitsOnUserAtom,
  WAITING_ON_YOU_SENTENCE,
} from "@/components/agent/agent-workspace-state";
import { useRunSummaryCollapsed } from "@/components/agent/run-summary-dock";
import { ShortcutKbd } from "@/components/agent/teaching-comment-composer";
import type { ShortcutPlatform } from "@/components/agent/teaching-comment-shortcuts";
import { ariaKeyShortcuts } from "@/components/agent/teaching-comment-shortcuts";
import type {
  TeachingRecordingGesture,
  TeachingSecondaryAction,
} from "@/components/agent/teaching-recording-state";
import {
  elapsedClock,
  teachingRecordingPresentation,
} from "@/components/agent/teaching-recording-state";
import {
  DockShell,
  DockState,
  DockStatus,
} from "@/components/agent/workspace-dock";
import type { DockStateTone } from "@/components/agent/workspace-dock";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { BrowserModificationBadge } from "./browser-modifications";

const TICK_MS = 1000;

/** Every label names what the button does to the recording (#210). */
const SECONDARY_LABEL: Record<TeachingSecondaryAction, string> = {
  "delete-recording": "Delete recording",
  "reject-flow": "Reject flow",
  "rename-flow": "Rename flow",
};

/** What a secondary reads once the stage is too narrow for the full label. */
const SECONDARY_SHORT_LABEL: Record<TeachingSecondaryAction, string> = {
  "delete-recording": "Delete",
  "reject-flow": "Reject",
  "rename-flow": "Rename",
};

/**
 * The elapsed time inside the Recording chip, as `mm:ss` in mono (#753). The
 * timer owns its own interval and its own render. Keeping the tick inside
 * this leaf is what stops a one-second clock from re-rendering the browser
 * canvas and the whole Workspace beside it.
 *
 * `role="timer"` carries no implicit live region, so the seconds are readable
 * on demand without a screen reader announcing every tick. State changes are
 * announced by the dock's own polite region instead.
 */
const RecordingElapsed = ({ startedAt }: { readonly startedAt: string }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const interval = globalThis.setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      globalThis.clearInterval(interval);
    };
  }, []);

  const clock = elapsedClock(startedAt, now);
  return (
    <span
      aria-label={`Elapsed recording time ${clock}`}
      className="font-mono text-xs tabular-nums opacity-85"
      role="timer"
    >
      {clock}
    </span>
  );
};

/**
 * A Guided Run names itself in the badge. While it records, the badge is one
 * phrase rather than two labels joined.
 */
/** What the dock's state badge says, and in which tone. */
interface DockBadge {
  readonly badge: string;
  readonly tone: DockStateTone;
}

/**
 * A Guided recording's badge names who holds the browser (#777): the agent
 * while it drives, then the takeover it asked for, then the user. Any open
 * request outranks all of that: the chip reads `Needs you` (#753).
 */
const guidedBadge = (
  origin: "teaching" | "guided-run" | undefined,
  tag: TeachingCaptureState["_tag"],
  presentation: DockBadge,
  controller: AgentSessionController,
  phase: AgentSessionPhase,
  waiting: boolean
): DockBadge => {
  if (waiting) {
    return { badge: "Needs you", tone: "attention" };
  }
  if (origin !== "guided-run") {
    return presentation;
  }
  if (tag !== "recording") {
    return { ...presentation, badge: `Guided Run · ${presentation.badge}` };
  }
  if (controller === "user") {
    return { badge: "You have control", tone: "live" };
  }
  return phase === "takeover"
    ? { badge: "Takeover requested", tone: "attention" }
    : { ...presentation, badge: "Guided recording" };
};

/**
 * Starting and stopping capture are labels alone, as in the prototype;
 * verifying and retrying are decisions about a recording, so they keep an
 * icon.
 */
const TeachingActionIcon = ({
  gesture,
}: {
  readonly gesture: TeachingRecordingGesture;
}) => {
  switch (gesture) {
    case "verify-flow": {
      return <CheckIcon aria-hidden="true" />;
    }
    case "retry-cleanup": {
      return <RotateCwIcon aria-hidden="true" />;
    }
    default: {
      return null;
    }
  }
};

/**
 * Each action's tone, as the prototype's buttons (#753): Start recording is
 * filled red, because it begins capture; every other one action, Stop
 * included, is filled neutral.
 */
const actionClassName = (gesture: TeachingRecordingGesture) =>
  gesture === "start"
    ? "bg-status-recording hover:bg-status-recording/90 ml-auto text-white"
    : "ml-auto";

/**
 * The way into the comment composer, with the comment count beside it. The
 * island shows no keycaps (#753): the chord is in the tooltip, and both the
 * chord and the bare `/` key, which works outside the Page, are in
 * aria-keyshortcuts. It reports whether the card it opens is open.
 */
const CommentTrigger = ({
  count,
  onComment,
  platform,
}: {
  readonly count: number;
  readonly onComment: () => void;
  readonly platform: ShortcutPlatform;
}) => {
  const open = useAtomValue(commentComposerOpenAtom);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-keyshortcuts={ariaKeyShortcuts("compose", platform)}
            aria-label={
              count === 0
                ? "Comment"
                : `Comment, ${count} ${count === 1 ? "comment" : "comments"} so far`
            }
            onClick={onComment}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <MessageSquareTextIcon aria-hidden="true" />
        <span className="hidden @md:inline">Comment</span>
        {count === 0 ? null : (
          <span className="bg-foreground text-background grid h-5 min-w-5 place-items-center rounded-[7px] px-1.5 font-mono text-xs leading-none font-semibold tabular-nums">
            {count}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        Comment
        <ShortcutKbd platform={platform} scope="chord" shortcut="compose" />
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * The actions the status island offers. A docked Flow decision takes Verify
 * flow and Reject flow (#757).
 */
const islandActions = (
  presentation: ReturnType<typeof teachingRecordingPresentation>,
  decisionDocked: boolean
) =>
  decisionDocked
    ? {
        action: null,
        secondaries: presentation.secondaries.filter(
          (secondary) => secondary !== "reject-flow"
        ),
      }
    : { action: presentation.action, secondaries: presentation.secondaries };

/**
 * The Teaching dock, on the same two-tier card a Run gets: whatever the agent
 * is waiting on, then the state badge with the next-step sentence, then one
 * row with the session picker, the comment trigger, the secondary actions,
 * and at most one primary action. It is driven entirely by the pushed capture
 * state (ADR 0039).
 *
 * The sentence used to sit behind an info button because inline it wrapped
 * the dock onto several lines (#297). In its own clamped line it no longer
 * can, so it is back where it is read, and a failed Dry Run's explanation
 * expands in place.
 */
export const TeachingRecordingDock = ({
  control,
  controlStatus,
  captureState,
  cleanup,
  controller,
  flowDecisionDocked,
  flowName,
  origin,
  instructions,
  onComment,
  onGesture,
  onSecondary,
  pending,
  phase,
  platform,
  requests,
  selectedSessionId,
  sessions,
}: {
  readonly control?: React.ReactNode;
  readonly controlStatus?: string;
  readonly captureState: TeachingCaptureState;
  readonly cleanup: TeachingRecordingCleanupState | undefined;
  /** Who holds the browser. Start waits for the agent's setup handoff. */
  readonly controller: AgentSessionController;
  readonly origin?: "teaching" | "guided-run";
  /**
   * Whether the docked Dry Run Summary carries the `Flow decision` region
   * (#757). While it does, Verify flow and Reject flow live there, not here.
   */
  readonly flowDecisionDocked?: boolean;
  readonly flowName: string;
  /**
   * Every Teaching instruction this recording has collected, oldest first,
   * whether attached through inspect or relayed over MCP.
   */
  readonly instructions: readonly TeachingInstruction[];
  readonly onComment: () => void;
  readonly onGesture: (gesture: TeachingRecordingGesture) => void;
  readonly onSecondary: (
    action: TeachingSecondaryAction,
    detail?: string
  ) => void;
  readonly pending: boolean;
  /** Whether the session is still live. An ended one offers no setup actions. */
  readonly phase: AgentSessionPhase;
  readonly platform: ShortcutPlatform;
  /** Setup Variables and other requests, in the Requests island. */
  readonly requests?: React.ReactNode;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
}) => {
  const presentation = teachingRecordingPresentation(
    captureState,
    cleanup,
    controller,
    phase
  );
  const waiting = useAtomValue(sessionWaitsOnUserAtom);
  const summaryCollapsed = useRunSummaryCollapsed();
  // While the summary is folded away, its Flow decision is too, so the
  // island offers Verify flow and Reject flow again.
  const { action, secondaries } = islandActions(
    presentation,
    flowDecisionDocked === true &&
      !summaryCollapsed &&
      captureState._tag === "dry-run-passed"
  );
  const badge = guidedBadge(
    origin,
    captureState._tag,
    presentation,
    controller,
    phase,
    waiting
  );
  const guidedRecording =
    origin === "guided-run" && captureState._tag === "recording";
  // A Guided Run reads Stop's whole name beside its control (#777).
  const actionLabel =
    guidedRecording && action !== null ? action.accessibleName : action?.label;
  let sentence = presentation.nextStep;
  if (guidedRecording) {
    sentence = controlStatus ?? presentation.nextStep;
  } else if (waiting) {
    sentence = WAITING_ON_YOU_SENTENCE;
  }
  const [rename, setRename] = useState("");
  const [renaming, setRenaming] = useState(false);
  const startRename = () => {
    setRename(flowName);
    setRenaming(true);
  };
  return (
    <DockShell
      footer={
        /*
          Renaming happens in the dock rather than behind a modal: the name is
          one field, and the user is looking at the browser it belongs to.
        */
        renaming ? (
          <form
            className="flex min-w-0 items-center gap-2 border-t px-2 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              onSecondary("rename-flow", rename);
              setRenaming(false);
            }}
          >
            <Input
              variant="compact"
              aria-label="Flow name"
              className="h-8 min-w-0 flex-1"
              onChange={(event) => setRename(event.target.value)}
              value={rename}
            />
            <Button size="sm" type="submit" variant="secondary">
              Save name
            </Button>
            <Button
              onClick={() => setRenaming(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel rename
            </Button>
          </form>
        ) : null
      }
      requests={requests}
      status={
        <DockStatus
          badges={
            <>
              <DockState tone={badge.tone}>
                {badge.badge}
                {/*
                  The time belongs to recording itself, so it shows only
                  while the chip says so: not while a takeover waits or the
                  user drives (#777).
                */}
                {captureState._tag === "recording" &&
                badge.tone === "recording" ? (
                  <RecordingElapsed startedAt={captureState.startedAt} />
                ) : null}
              </DockState>
              {/*
                Teaching has no Task details, so this is the only place a
                Teaching session's active Browser Modifications show.
              */}
              <BrowserModificationBadge
                modifications={
                  sessions.find((session) => session.id === selectedSessionId)
                    ?.browserModifications ?? []
                }
              />
            </>
          }
          note={
            presentation.retainedFiles === undefined
              ? undefined
              : `Still on disk: ${presentation.retainedFiles.join(", ")}`
          }
        >
          {/*
            The sentence changes when the capture state changes, never on a
            timer tick: the elapsed clock owns its own leaf render.
          */}
          {sentence}
        </DockStatus>
      }
    >
      {presentation.showsInspect ? (
        <CommentTrigger
          count={instructions.length}
          onComment={onComment}
          platform={platform}
        />
      ) : null}
      {/*
        Secondaries are quiet: the island has one action (#753). Rename
        stays here while there is no other place in the session to rename
        the Flow.
      */}
      {secondaries.map((secondary) => (
        <Button
          aria-label={SECONDARY_LABEL[secondary]}
          disabled={pending}
          key={secondary}
          onClick={() =>
            secondary === "rename-flow" ? startRename() : onSecondary(secondary)
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          {/*
            A narrow dock wraps the session picker onto its own row, so even
            there a secondary keeps a word: an X alone reads as dismiss.
          */}
          <span className="@md:hidden">{SECONDARY_SHORT_LABEL[secondary]}</span>
          <span className="hidden @md:inline">
            {SECONDARY_LABEL[secondary]}
          </span>
        </Button>
      ))}
      {control}
      {action === null ? null : (
        <Button
          size="md"
          variant="primary"
          // When the actions wrap, the primary one keeps the end of its line.
          className={actionClassName(action.gesture)}
          aria-label={action.accessibleName}
          disabled={pending}
          onClick={() => onGesture(action.gesture)}
          type="button"
        >
          <TeachingActionIcon gesture={action.gesture} />
          {action.gesture === "start" ? (
            <>
              <span className="@sm:hidden">Record</span>
              <span className="hidden @sm:inline">{action.label}</span>
            </>
          ) : (
            actionLabel
          )}
        </Button>
      )}
    </DockShell>
  );
};

/**
 * What a Teaching dock has to say above the browser. It is a separate export
 * so the shell can stack it with the Workspace's own notices in one overlay
 * rather than two that land on top of each other (#209).
 */
export const TeachingRecordingNotices = ({
  captureState,
  error,
  recordingId,
}: {
  readonly captureState: TeachingCaptureState;
  readonly error: string | undefined;
  readonly recordingId: string;
}) => (
  <>
    {error === undefined ? null : (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>That gesture did not go through</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )}
    {/*
      A capture failure is not dismissable: a limit or an encoder failure ended
      the recording, and what was captured is still on disk, so the user needs
      to know it is recoverable rather than lost (#183).
    */}
    {captureState._tag === "failed" ? (
      <Alert variant="destructive">
        <CircleAlertIcon aria-hidden="true" />
        <AlertTitle>Recording failed</AlertTitle>
        <AlertDescription>
          <span>{captureState.error}</span>
          <span>
            What was captured before the failure is retained under{" "}
            <span className="font-mono wrap-anywhere">{recordingId}</span> and
            can still be recovered.
          </span>
        </AlertDescription>
      </Alert>
    ) : null}
  </>
);
