import type {
  FlowSkillName,
  TeachingCaptureState,
} from "@contingency/protocol";
import {
  CircleAlertIcon,
  CircleIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { TeachingRecordingGesture } from "@/components/agent/teaching-recording-state";
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
 * The Teaching recording dock: one state badge, one next-step sentence, and at
 * most one action, driven entirely by the pushed capture state (ADR 0039).
 */
export const TeachingRecordingDock = ({
  captureState,
  error,
  flowSkillName,
  onGesture,
  pending,
  recordingId,
}: {
  readonly captureState: TeachingCaptureState;
  /** What went wrong the last time this dock dispatched a gesture. */
  readonly error: string | undefined;
  readonly flowSkillName: FlowSkillName;
  readonly onGesture: (gesture: TeachingRecordingGesture) => void;
  readonly pending: boolean;
  readonly recordingId: string;
}) => {
  const presentation = teachingRecordingPresentation(captureState);
  const { action } = presentation;
  return (
    <section
      aria-label="Teaching recording"
      className="flex flex-col gap-2 border-b px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
        <span className="text-sm font-medium">{flowSkillName}</span>
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
          state changes, never on a timer tick.
        */}
        <output
          aria-live="polite"
          className="text-muted-foreground min-w-0 flex-1 text-xs"
        >
          {presentation.badge}. {presentation.nextStep}
        </output>
        {action === null ? null : (
          <Button
            aria-label={action.accessibleName}
            disabled={pending}
            onClick={() => onGesture(action.gesture)}
            type="button"
            variant={action.gesture === "stop" ? "destructive" : "default"}
          >
            {action.gesture === "stop" ? (
              <SquareIcon aria-hidden="true" className="fill-current" />
            ) : (
              <CircleIcon aria-hidden="true" className="fill-current" />
            )}
            {action.label}
          </Button>
        )}
      </div>
      {error === undefined ? null : (
        <p className="text-destructive text-xs">{error}</p>
      )}
      {/*
        A capture failure is not dismissable: a limit or an encoder failure
        ended the recording, and what was captured is still on disk, so the
        user needs to know it is recoverable rather than lost (#183).
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
    </section>
  );
};
