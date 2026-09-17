import type {
  AgentSessionId,
  AgentSessionSnapshot,
  TeachingCaptureState,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";
import {
  CircleAlertIcon,
  CircleIcon,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const TICK_MS = 1000;

const badgeVariant = (
  tone: ReturnType<typeof teachingRecordingPresentation>["tone"]
): "default" | "destructive" | "secondary" => {
  if (tone === "failed") {
    return "destructive";
  }
  return tone === "recording" ? "default" : "secondary";
};

const SECONDARY_LABEL: Record<TeachingSecondaryAction, string> = {
  "copy-prompt": "Copy agent prompt",
  "copy-run-prompt": "Run flow",
  "delete-recording": "Delete recording",
  "learn-again": "Learn again",
  "read-failure": "Read failure",
  "read-flow-skill": "Read flow skill",
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

const Wordmark = () => (
  <span className="shrink-0 text-base font-semibold tracking-tight">
    Contingency
  </span>
);

/**
 * The session picker inside the dock. A Teaching option is the Flow Skill name
 * alone: the capture state lives in the badge beside it, and a raw session id
 * is never a label a person can act on (#191).
 */
const DockSessionSelect = ({
  onSelect,
  selectedSessionId,
  sessions,
}: {
  readonly onSelect: (sessionId: string) => void;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
}) => (
  <select
    aria-label="Agent Session"
    className="bg-background focus-visible:ring-ring h-8 max-w-[12rem] min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
    onChange={(event) => onSelect(event.target.value)}
    value={selectedSessionId ?? ""}
  >
    {sessions.map((session) => (
      <option key={session.id} value={session.id}>
        {session.activity === "teaching"
          ? session.flowSkillName
          : `${session.clientName} · Interactive Run`}
      </option>
    ))}
  </select>
);

/**
 * The dock shell: one floating card over a full-bleed browser, with no header
 * band and no footer. Every Workspace state that owns the whole viewport
 * renders through this, so `no session` and a live Teaching session share one
 * layout instead of two (#185 prototype).
 */
const DockShell = ({ children }: { readonly children: React.ReactNode }) => (
  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-3">
    <section
      aria-label="Workspace dock"
      className="bg-background pointer-events-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 shadow-lg"
    >
      {children}
    </section>
  </div>
);

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
    <output
      aria-live="polite"
      className="text-muted-foreground order-last hidden w-full text-xs sm:block lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
    >
      No session. Open a session to set the browser up, then start recording
      when the journey begins.
    </output>
  </DockShell>
);

/**
 * The Teaching dock: the Flow Skill name, one state badge, one next-step
 * sentence, the inspect toggle, the secondary actions, and at most one primary
 * action, driven entirely by the pushed capture state (ADR 0039).
 */
export const TeachingRecordingDock = ({
  captureState,
  cleanup,
  commentCount,
  error,
  flowSkillName,
  inspecting,
  onGesture,
  onSecondary,
  onSelectSession,
  onToggleInspect,
  pending,
  recordingId,
  selectedSessionId,
  sessions,
}: {
  readonly captureState: TeachingCaptureState;
  readonly cleanup: TeachingRecordingCleanupState | undefined;
  /** How many inspect comments this recording has collected. */
  readonly commentCount: number;
  /** What went wrong the last time this dock dispatched a gesture. */
  readonly error: string | undefined;
  readonly flowSkillName: string;
  readonly inspecting: boolean;
  readonly onGesture: (gesture: TeachingRecordingGesture) => void;
  readonly onSecondary: (
    action: TeachingSecondaryAction,
    detail?: string
  ) => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onToggleInspect: () => void;
  readonly pending: boolean;
  readonly recordingId: string;
  readonly selectedSessionId: AgentSessionId | undefined;
  readonly sessions: readonly AgentSessionSnapshot[];
}) => {
  const presentation = teachingRecordingPresentation(captureState, cleanup);
  const { action } = presentation;
  const [rename, setRename] = useState("");
  const [renaming, setRenaming] = useState(false);
  const startRename = () => {
    setRename(flowSkillName);
    setRenaming(true);
  };
  return (
    <>
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
          One polite region for the state itself. It changes when the capture
          state changes, never on a timer tick. Below `lg` it takes its own
          line, and below `sm` it is hidden: the badge and the buttons already
          carry the state and the next step, so it is never ellipsized.
        */}
        <output
          aria-live="polite"
          className="text-muted-foreground order-last hidden w-full text-xs sm:block lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
        >
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
        {commentCount > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {commentCount} {commentCount === 1 ? "comment" : "comments"}
          </span>
        ) : null}
        {presentation.secondaries.map((secondary) => (
          <Button
            key={secondary}
            onClick={() =>
              secondary === "rename-flow"
                ? startRename()
                : onSecondary(secondary)
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
      {error === undefined && captureState._tag !== "failed" ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
          <div className="pointer-events-auto w-full max-w-5xl space-y-2">
            {error === undefined ? null : (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>That gesture did not go through</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {/*
              A capture failure is not dismissable: a limit or an encoder
              failure ended the recording, and what was captured is still on
              disk, so the user needs to know it is recoverable rather than
              lost (#183).
            */}
            {captureState._tag === "failed" ? (
              <Alert variant="destructive">
                <CircleAlertIcon aria-hidden="true" />
                <AlertTitle>Recording failed</AlertTitle>
                <AlertDescription>
                  <span>{captureState.error}</span>
                  <span>
                    What was captured before the failure is retained under{" "}
                    <span className="font-mono wrap-anywhere">
                      {recordingId}
                    </span>{" "}
                    and can still be recovered.
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
};
