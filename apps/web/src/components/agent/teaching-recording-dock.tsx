import type {
  AgentSessionController,
  AgentSessionPhase,
  AgentSessionId,
  AgentSessionSnapshot,
  TeachingCaptureState,
  TeachingInstruction,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";
import {
  CircleAlertIcon,
  CircleIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ShortcutKbd } from "@/components/agent/teaching-comment-composer";
import type { ShortcutPlatform } from "@/components/agent/teaching-comment-shortcuts";
import { ariaKeyShortcuts } from "@/components/agent/teaching-comment-shortcuts";
import type {
  TeachingRecordingGesture,
  TeachingSecondaryAction,
} from "@/components/agent/teaching-recording-state";
import {
  elapsedLabel,
  elapsedSpokenLabel,
  teachingRecordingPresentation,
} from "@/components/agent/teaching-recording-state";
import {
  DockSessionSelect,
  DockShell,
  DockSpacer,
  DockStatus,
  DockWordmark,
  Wordmark,
} from "@/components/agent/workspace-dock";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const TICK_MS = 1000;

const badgeVariant = (
  tone: ReturnType<typeof teachingRecordingPresentation>["tone"]
): "default" | "destructive" | "secondary" => {
  if (tone === "failed") {
    return "destructive";
  }
  return tone === "recording" ? "default" : "secondary";
};

/** Every label names what the button does to the recording (#210). */
const SECONDARY_LABEL: Record<TeachingSecondaryAction, string> = {
  "delete-recording": "Delete recording",
  "reject-flow": "Reject flow",
  "rename-flow": "Rename flow",
};

/**
 * The elapsed timer owns its own interval and its own render. Keeping the tick
 * inside this leaf is what stops a one-second clock from re-rendering the
 * browser canvas and the whole Workspace beside it.
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

  return (
    <span
      aria-label={elapsedSpokenLabel(startedAt, now)}
      className="font-mono text-sm tabular-nums"
      role="timer"
    >
      {elapsedLabel(startedAt, now)}
    </span>
  );
};

/**
 * The Workspace dock with no Agent Session behind it. The canvas owns the
 * invitation here, so the dock deliberately offers no primary action: two
 * controls reading **Open browser session** was what the prototype's own
 * capture check caught first.
 */
export const WorkspaceEmptyDock = ({
  skills = null,
}: {
  /** The Skills drawer entry, beside the wordmark. */
  readonly skills?: React.ReactNode;
}) => (
  <DockShell
    status={
      <DockStatus badges={<Badge variant="secondary">No session</Badge>}>
        Open a session to set the browser up, then start recording when the
        journey begins.
      </DockStatus>
    }
  >
    <span className="pl-1">
      <Wordmark />
    </span>
    {skills}
  </DockShell>
);

/**
 * The way into the comment composer, with the comment count beside it. The
 * shortcut hint follows focus: with the browser focused, single keys belong to
 * the Page, so only the chord opens the composer.
 */
const CommentTrigger = ({
  browserFocused,
  count,
  onComment,
  platform,
}: {
  readonly browserFocused: boolean;
  readonly count: number;
  readonly onComment: () => void;
  readonly platform: ShortcutPlatform;
}) => (
  <Button
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
  >
    <MessageSquareTextIcon aria-hidden="true" />
    <span className="hidden @md:inline">Comment</span>
    {count === 0 ? null : (
      <span className="text-muted-foreground tabular-nums">{count}</span>
    )}
    <ShortcutKbd
      className="hidden @lg:inline-flex"
      platform={platform}
      scope={browserFocused ? "chord" : "bare"}
      shortcut="compose"
    />
  </Button>
);

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
  browserFocused,
  captureState,
  cleanup,
  controller,
  flowSkillName,
  instructions,
  onComment,
  onGesture,
  onSecondary,
  onSelectSession,
  pending,
  phase,
  platform,
  requests,
  selectedSessionId,
  sessions,
  skills = null,
}: {
  /** Whether the live browser holds focus, which changes the shortcut hint. */
  readonly browserFocused: boolean;
  readonly captureState: TeachingCaptureState;
  readonly cleanup: TeachingRecordingCleanupState | undefined;
  /** Who holds the browser. Start waits for the agent's setup handoff. */
  readonly controller: AgentSessionController;
  readonly flowSkillName: string;
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
  readonly onSelectSession: (sessionId: string) => void;
  readonly pending: boolean;
  /** Whether the session is still live. An ended one offers no setup actions. */
  readonly phase: AgentSessionPhase;
  readonly platform: ShortcutPlatform;
  /** Setup Variables and other requests, as the dock's first tier. */
  readonly requests?: React.ReactNode;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
  /** The Skills drawer entry, beside the session picker, or nothing. */
  readonly skills?: React.ReactNode;
}) => {
  const presentation = teachingRecordingPresentation(
    captureState,
    cleanup,
    controller,
    phase
  );
  const { action } = presentation;
  const [rename, setRename] = useState("");
  const [renaming, setRenaming] = useState(false);
  const startRename = () => {
    setRename(flowSkillName);
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
              aria-label="Flow skill name"
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
              <Badge variant={badgeVariant(presentation.tone)}>
                {presentation.tone === "recording" ? (
                  <CircleIcon
                    aria-hidden="true"
                    className="fill-current text-red-500"
                  />
                ) : null}
                {presentation.tone === "failed" ? (
                  <CircleAlertIcon aria-hidden="true" />
                ) : null}
                {presentation.badge}
              </Badge>
              {captureState._tag === "recording" ? (
                <RecordingElapsed startedAt={captureState.startedAt} />
              ) : null}
              {captureState._tag === "finalizing" ? (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-4 animate-spin"
                />
              ) : null}
            </>
          }
        >
          {/*
            The sentence changes when the capture state changes, never on a
            timer tick: the elapsed clock owns its own leaf render.
          */}
          {presentation.nextStep}
        </DockStatus>
      }
    >
      <DockWordmark />
      <DockSessionSelect
        onSelect={onSelectSession}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
      />
      {skills}
      <DockSpacer />
      {presentation.showsInspect ? (
        <CommentTrigger
          browserFocused={browserFocused}
          count={instructions.length}
          onComment={onComment}
          platform={platform}
        />
      ) : null}
      {presentation.secondaries.map((secondary) => (
        <Button
          disabled={pending}
          key={secondary}
          onClick={() =>
            secondary === "rename-flow" ? startRename() : onSecondary(secondary)
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {SECONDARY_LABEL[secondary]}
        </Button>
      ))}
      {action === null ? null : (
        <Button
          aria-label={action.accessibleName}
          disabled={pending}
          onClick={() => onGesture(action.gesture)}
          type="button"
          variant={
            action.gesture === "stop" || action.gesture === "stop-dry-run"
              ? "destructive"
              : "default"
          }
        >
          {action.gesture === "stop" || action.gesture === "stop-dry-run" ? (
            <SquareIcon aria-hidden="true" className="fill-current" />
          ) : (
            <CircleIcon aria-hidden="true" className="fill-current" />
          )}
          {action.label}
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
