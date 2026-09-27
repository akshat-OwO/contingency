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
  InfoIcon,
  LoaderCircleIcon,
  MousePointerClickIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

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
  DockStatus,
  Wordmark,
} from "@/components/agent/workspace-dock";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

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
export const WorkspaceEmptyDock = () => (
  <DockShell>
    <Wordmark />
    <Badge variant="secondary">No session</Badge>
    <DockStatus>
      No session. Open a session to set the browser up, then start recording
      when the journey begins.
    </DockStatus>
  </DockShell>
);

/**
 * The comments this recording has collected, behind their own count. The count
 * is a control rather than a label: a user who attached several instructions
 * has no other way to read back what they said or which element each one
 * landed on (#213). The list is read-only — an instruction is a recorded
 * event, so retracting one has to be recorded rather than rewritten.
 *
 * With nothing attached there is no control at all, so the dock never offers a
 * button that opens an empty overlay.
 */
const RecordingComments = ({
  instructions,
}: {
  readonly instructions: readonly TeachingInstruction[];
}) => {
  if (instructions.length === 0) {
    return null;
  }
  const count = instructions.length;
  /* Newest first: the instruction just attached is the one being checked. */
  const newestFirst = instructions.toReversed();
  return (
    <Popover>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            aria-label={`${count} ${count === 1 ? "comment" : "comments"}`}
            size="sm"
            variant="ghost"
          >
            <span className="tabular-nums">{count}</span>
            {count === 1 ? "comment" : "comments"}
          </Button>
        )}
      />
      <PopoverContent align="end">
        <ul className="flex max-h-64 flex-col gap-2.5 overflow-y-auto">
          {newestFirst.map((instruction) => (
            <li className="flex flex-col gap-0.5" key={instruction.id}>
              <span>{instruction.text}</span>
              {instruction.target === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {instruction.target}
                </span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The state's next-step sentence, behind its own button. Inline, the sentence
 * wrapped the dock onto several lines, and after a failed Dry Run it carried
 * the whole failure explanation. Here the dock stays one row and the sentence
 * stays reachable, which matters when a Dry Run Summary is absent and this is
 * the only place the failure is explained (#297).
 */
const StateDetails = ({
  badge,
  nextStep,
}: {
  readonly badge: string;
  readonly nextStep: string;
}) => (
  <Popover>
    <PopoverTrigger
      render={(props) => (
        <Button
          {...props}
          aria-label="Show details"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <InfoIcon />
        </Button>
      )}
    />
    <PopoverContent align="end" className="w-80">
      <PopoverHeader>
        <PopoverTitle>{badge}</PopoverTitle>
        <PopoverDescription className="text-pretty wrap-anywhere">
          {nextStep}
        </PopoverDescription>
      </PopoverHeader>
    </PopoverContent>
  </Popover>
);

/**
 * The Teaching dock: the Flow Skill name, one state badge, the inspect toggle,
 * the state's details, the secondary actions, and at most one primary action,
 * on one row and driven entirely by the pushed capture state (ADR 0039).
 */
export const TeachingRecordingDock = ({
  captureState,
  cleanup,
  controller,
  flowSkillName,
  instructions,
  inspecting,
  onGesture,
  onSecondary,
  onSelectSession,
  onToggleInspect,
  pending,
  phase,
  selectedSessionId,
  sessions,
}: {
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
  readonly inspecting: boolean;
  readonly onGesture: (gesture: TeachingRecordingGesture) => void;
  readonly onSecondary: (
    action: TeachingSecondaryAction,
    detail?: string
  ) => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onToggleInspect: () => void;
  readonly pending: boolean;
  /** Whether the session is still live. An ended one offers no setup actions. */
  readonly phase: AgentSessionPhase;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
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
    <DockShell>
      <Wordmark />
      <DockSessionSelect
        onSelect={onSelectSession}
        selectedSessionId={selectedSessionId}
        sessions={sessions}
      />
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
      {/*
          The state sentence changes when the capture state changes, never on a
          timer tick: the elapsed clock owns its own leaf render. It is spoken
          here and read from the details popover, so it never widens the dock.
        */}
      <output aria-live="polite" className="sr-only">
        {presentation.badge}. {presentation.nextStep}
      </output>
      {presentation.showsInspect ? (
        <Button
          aria-label="Inspect an element and comment"
          aria-pressed={inspecting}
          onClick={onToggleInspect}
          size="icon-sm"
          type="button"
          variant={inspecting ? "secondary" : "ghost"}
        >
          <MousePointerClickIcon />
        </Button>
      ) : null}
      <RecordingComments instructions={instructions} />
      <StateDetails
        badge={presentation.badge}
        nextStep={presentation.nextStep}
      />
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
      {/*
          Renaming happens in the dock rather than behind a modal: the name is
          one field, and the user is looking at the browser it belongs to.
        */}
      {renaming ? (
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSecondary("rename-flow", rename);
            setRenaming(false);
          }}
        >
          <input
            aria-label="Flow skill name"
            className="bg-background focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
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
      ) : null}
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
