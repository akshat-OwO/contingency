import type {
  AuditKind,
  RecordedStep,
  RecordingSnapshot,
} from "@contingency/protocol";
import { isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import {
  DownloadIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createWorkspaceAtom } from "@/components/create/create-workspace-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  recordingAuditMutation,
  recordingCaptureCancelMutation,
  recordingDiscardMutation,
  recordingFinishMutation,
  recordingPauseMutation,
  recordingPreStepConditionMutation,
  recordingPreStepMutation,
  recordingRecoverMutation,
  recordingResumeMutation,
  recordingSecretBindMutation,
  recordingSecretRenameMutation,
  recordingStartMutation,
  recordingStepDeleteMutation,
  recordingStepUndoMutation,
  recordingTitleMutation,
} from "@/lib/rpc";

const errorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Unable to update the Recording.";

const stepLabel = (recorded: RecordedStep): string => {
  const { step } = recorded;
  if (step.type === "navigate") {
    try {
      return `Navigate to ${new URL(step.url).hostname}`;
    } catch {
      return "Navigate";
    }
  }
  if (step.type === "change") {
    return recorded.secretVariable === undefined
      ? "Change form value"
      : `Enter {{${recorded.secretVariable}}}`;
  }
  if (step.type === "click") {
    return "Click element";
  }
  return `${step.type === "keyDown" ? "Press" : "Release"} ${step.key}`;
};

const selectorLabel = (recorded: RecordedStep): string | undefined => {
  if (recorded.step.type === "navigate") {
    return recorded.step.url;
  }
  const [selector] = recorded.step.selectors;
  return typeof selector === "string" ? selector : selector?.join(" → ");
};

const downloadFlow = (recording: RecordingSnapshot): void => {
  if (recording.downloadName === undefined) {
    return;
  }
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(recording.flow, null, 2)}\n`], {
      type: "application/json",
    })
  );
  const link = document.createElement("a");
  link.download = recording.downloadName;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
};

interface StepCardProps {
  readonly busy: boolean;
  readonly index: number;
  readonly onAudit: (
    stepId: string,
    audit: AuditKind,
    enabled: boolean
  ) => void;
  readonly onDelete: (stepId: string) => void;
  readonly onCondition: (stepId: string, index: number) => void;
  readonly onPreStep: (stepId: string) => void;
  readonly onSecret: (stepId: string, name: string) => void;
  readonly recording: RecordingSnapshot;
  readonly secretVariables: readonly string[];
  readonly step: RecordedStep;
}

const StepCard = ({
  busy,
  index,
  onAudit,
  onCondition,
  onDelete,
  onPreStep,
  onSecret,
  recording,
  secretVariables,
  step,
}: StepCardProps) => {
  const frozen =
    recording.phase === "finished" || recording.phase === "incomplete";
  const initial = index === 0;
  const accessibility = step.audits.some(
    ({ type }) => type === "accessibility"
  );
  const performance = step.audits.some(({ type }) => type === "performance");

  return (
    <li className="bg-card space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Badge className="mt-0.5 tabular-nums" variant="outline">
          {index + 1}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{stepLabel(step)}</p>
          <p
            className="text-muted-foreground truncate text-xs"
            title={selectorLabel(step)}
          >
            {selectorLabel(step)}
          </p>
          {step.preSteps.length > 0 ? (
            <div className="text-muted-foreground mt-1 space-y-1 text-xs">
              {step.preSteps.map((preStep, preStepIndex) => (
                <div className="flex items-center gap-2" key={preStep.id}>
                  <span>Pre-step {preStepIndex + 1}</span>
                  <button
                    className="underline underline-offset-2"
                    disabled={busy || frozen}
                    onClick={() => onCondition(step.id, preStepIndex)}
                    type="button"
                  >
                    Pick condition
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {initial ? null : (
          <Button
            aria-label={`Delete Step ${index + 1}`}
            disabled={busy || frozen}
            onClick={() => onDelete(step.id)}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {initial ? null : (
          <Button
            disabled={busy || frozen}
            onClick={() => onPreStep(step.id)}
            size="xs"
            variant="outline"
          >
            Add Pre-step
          </Button>
        )}
        <Button
          aria-pressed={accessibility}
          disabled={busy || frozen}
          onClick={() => onAudit(step.id, "accessibility", !accessibility)}
          size="xs"
          variant={accessibility ? "secondary" : "outline"}
        >
          Accessibility
        </Button>
        <Button
          aria-pressed={performance}
          disabled={busy || frozen}
          onClick={() => onAudit(step.id, "performance", !performance)}
          size="xs"
          variant={performance ? "secondary" : "outline"}
        >
          Performance
        </Button>
        {step.step.type === "change" && step.secretVariable === undefined ? (
          <Button
            disabled={busy || frozen}
            onClick={() => onSecret(step.id, "SECRET")}
            size="xs"
            variant="outline"
          >
            Mark secret
          </Button>
        ) : null}
        {step.step.type === "change" && step.secretVariable !== undefined ? (
          <select
            aria-label={`Secret Variable for Step ${index + 1}`}
            className="bg-background h-7 rounded-md border px-2 text-xs"
            disabled={busy || frozen}
            onChange={(event) => onSecret(step.id, event.target.value)}
            value={step.secretVariable}
          >
            {secretVariables.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </li>
  );
};

interface RecordingControlsProps {
  readonly busy: boolean;
  readonly confirmDiscard: boolean;
  readonly onDiscard: () => void;
  readonly onFinish: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStart: () => void;
  readonly recording: RecordingSnapshot | null;
  readonly startDisabled: boolean;
}

const RecordingControls = ({
  busy,
  confirmDiscard,
  onDiscard,
  onFinish,
  onPause,
  onResume,
  onStart,
  recording,
  startDisabled,
}: RecordingControlsProps) => {
  const finishDisabled =
    busy ||
    recording === null ||
    recording.recordedSteps.length < 2 ||
    recording.captureMode !== "ordinary";

  return (
    <div className="shrink-0 space-y-2 border-t p-4">
      {recording === null ? (
        <Button className="w-full" disabled={startDisabled} onClick={onStart}>
          <PlayIcon data-icon="inline-start" />
          Start Recording
        </Button>
      ) : null}
      {recording?.phase === "active" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={busy || recording.captureMode !== "ordinary"}
            onClick={onPause}
            variant="outline"
          >
            <PauseIcon />
            Pause
          </Button>
          <Button disabled={finishDisabled} onClick={onFinish}>
            <SquareIcon />
            Finish
          </Button>
        </div>
      ) : null}
      {recording?.phase === "paused" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={busy || recording.captureMode !== "ordinary"}
            onClick={onResume}
          >
            <PlayIcon />
            Resume
          </Button>
          <Button
            disabled={finishDisabled}
            onClick={onFinish}
            variant="outline"
          >
            <SquareIcon />
            Finish
          </Button>
        </div>
      ) : null}
      {recording?.phase === "finished" ? (
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => downloadFlow(recording)}
        >
          <DownloadIcon />
          Download {recording.downloadName}
        </Button>
      ) : null}
      {recording === null ? null : (
        <Button
          className="w-full"
          disabled={busy}
          onClick={onDiscard}
          variant="ghost"
        >
          <Trash2Icon />
          {confirmDiscard ? "Confirm discard" : "Discard"}
        </Button>
      )}
    </div>
  );
};

// The panel intentionally coordinates the complete authoring lifecycle in one
// accessible surface; individual Step rendering remains isolated above.
// oxlint-disable-next-line eslint/complexity
const InstructionsPanel = () => {
  const [workspace, setWorkspace] = useAtom(createWorkspaceAtom);
  const [title, setTitle] = useState(workspace.recording?.flow.title ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string>();
  const serverTitleRef = useRef(workspace.recording?.flow.title);
  const start = useAtomSet(recordingStartMutation, { mode: "promise" });
  const pause = useAtomSet(recordingPauseMutation, { mode: "promise" });
  const resume = useAtomSet(recordingResumeMutation, { mode: "promise" });
  const recover = useAtomSet(recordingRecoverMutation, { mode: "promise" });
  const finish = useAtomSet(recordingFinishMutation, { mode: "promise" });
  const discard = useAtomSet(recordingDiscardMutation, { mode: "promise" });
  const updateTitle = useAtomSet(recordingTitleMutation, { mode: "promise" });
  const deleteStep = useAtomSet(recordingStepDeleteMutation, {
    mode: "promise",
  });
  const undoDelete = useAtomSet(recordingStepUndoMutation, { mode: "promise" });
  const setAudit = useAtomSet(recordingAuditMutation, { mode: "promise" });
  const bindSecret = useAtomSet(recordingSecretBindMutation, {
    mode: "promise",
  });
  const renameSecret = useAtomSet(recordingSecretRenameMutation, {
    mode: "promise",
  });
  const armPreStep = useAtomSet(recordingPreStepMutation, { mode: "promise" });
  const armCondition = useAtomSet(recordingPreStepConditionMutation, {
    mode: "promise",
  });
  const cancelCapture = useAtomSet(recordingCaptureCancelMutation, {
    mode: "promise",
  });
  const { recording, selectedSessionId, address } = workspace;

  useEffect(() => {
    if (recording !== null && recording.flow.title !== serverTitleRef.current) {
      serverTitleRef.current = recording.flow.title;
      setTitle(recording.flow.title);
    }
  }, [recording]);

  const applyRecording = (next: RecordingSnapshot | null) => {
    setWorkspace((current) => ({ ...current, recording: next }));
  };

  const run = async (operation: () => Promise<RecordingSnapshot | null>) => {
    if (busy) {
      return false;
    }
    setBusy(true);
    setError(undefined);
    try {
      applyRecording(await operation());
      return true;
    } catch (operationError) {
      setError(errorMessage(operationError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runResult = (
    operation: () => Promise<{
      readonly data: { readonly recording: RecordingSnapshot | null };
    }>
  ) =>
    run(async () => {
      const result = await operation();
      return result.data.recording;
    });

  const startRecording = () => {
    if (selectedSessionId === undefined) {
      return;
    }
    void runResult(() =>
      start({
        payload: {
          data: { sessionId: selectedSessionId, title },
          type: "recording.start",
        },
      })
    );
  };

  const discardRecording = () => {
    const hasAuthoredContent =
      recording !== null &&
      (recording.recordedSteps.length > 1 ||
        (recording.flow.contingency?.preSteps?.length ?? 0) > 0 ||
        (recording.flow.contingency?.secretVariables?.length ?? 0) > 0 ||
        recording.recordedSteps.some(({ audits }) => audits.length > 0));
    if (hasAuthoredContent && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    const discardCurrent = async () => {
      await discard({ payload: { data: {}, type: "recording.discard" } });
      return null;
    };
    const discardAndResetConfirmation = async () => {
      const succeeded = await run(discardCurrent);
      if (succeeded) {
        setConfirmDiscard(false);
      }
    };
    void discardAndResetConfirmation();
  };

  const setStepAudit = (stepId: string, audit: AuditKind, enabled: boolean) => {
    void runResult(() =>
      setAudit({
        payload: {
          data: { audit, enabled, stepId },
          type: "recording.step.audit.set",
        },
      })
    );
  };

  const startDisabled =
    busy ||
    selectedSessionId === undefined ||
    address.trim().length === 0 ||
    title.trim().length === 0;

  return (
    <aside
      aria-labelledby="flow-authoring-heading"
      className="bg-background flex size-full min-h-0 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium" id="flow-authoring-heading">
          Flow authoring
        </h2>
        {recording === null ? null : (
          <Badge
            variant={
              recording.phase === "incomplete" ? "destructive" : "outline"
            }
          >
            {recording.phase}
          </Badge>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="flow-title">
              Flow title
            </label>
            <Input
              disabled={busy || recording?.phase === "finished"}
              id="flow-title"
              onBlur={() => {
                if (recording !== null && title !== recording.flow.title) {
                  void runResult(() =>
                    updateTitle({
                      payload: {
                        data: { title },
                        type: "recording.title.update",
                      },
                    })
                  );
                }
              }}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="For example: Pharmacy"
              value={title}
            />
            <p className="text-muted-foreground text-xs">
              Start from the current page in the selected browser session.
            </p>
          </div>
          {recording?.phase === "incomplete" ? (
            <div
              className="border-destructive/40 bg-destructive/10 rounded-lg border p-3 text-sm"
              role="alert"
            >
              <p className="font-medium">Recording is incomplete</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {recording.incompleteReason}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                Reloading restores capture from a navigation checkpoint. Actions
                performed after the failure are not retained.
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void runResult(() =>
                    recover({
                      payload: { data: {}, type: "recording.recover" },
                    })
                  );
                }}
                size="sm"
                variant="outline"
              >
                <RotateCcwIcon />
                Reload &amp; Resume
              </Button>
            </div>
          ) : null}
          {error === undefined ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          {recording !== null && recording.captureMode !== "ordinary" ? (
            <div className="bg-muted/30 rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {recording.captureMode === "conditionPicker"
                  ? "Pick the condition element"
                  : "Record the next Pre-step"}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {recording.captureMode === "conditionPicker"
                  ? "Click the element whose visibility should enable this Pre-step."
                  : "Perform one click, form change, or meaningful key action in the browser."}
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void runResult(() =>
                    cancelCapture({
                      payload: { data: {}, type: "recording.capture.cancel" },
                    })
                  );
                }}
                size="sm"
                variant="outline"
              >
                Cancel Pre-step
              </Button>
            </div>
          ) : null}

          <Separator />

          {(recording?.flow.contingency?.secretVariables?.length ?? 0) > 0 ? (
            <section
              aria-labelledby="secret-variables-heading"
              className="space-y-2"
            >
              <h3 className="text-sm font-medium" id="secret-variables-heading">
                Secret Variables
              </h3>
              {recording?.flow.contingency?.secretVariables?.map(({ name }) => (
                <Input
                  aria-label={`Rename ${name}`}
                  defaultValue={name}
                  disabled={
                    busy ||
                    recording.phase === "finished" ||
                    recording.phase === "incomplete"
                  }
                  key={name}
                  onBlur={(event) => {
                    if (event.target.value !== name) {
                      void runResult(() =>
                        renameSecret({
                          payload: {
                            data: { from: name, name: event.target.value },
                            type: "recording.secret.rename",
                          },
                        })
                      );
                    }
                  }}
                />
              ))}
            </section>
          ) : null}

          {(recording?.flow.contingency?.preSteps?.length ?? 0) > 0 ? (
            <section
              aria-labelledby="flow-pre-steps-heading"
              className="space-y-2"
            >
              <h3 className="text-sm font-medium" id="flow-pre-steps-heading">
                Flow Pre-steps
              </h3>
              {recording?.flow.contingency?.preSteps?.map((preStep, index) => (
                <Button
                  disabled={
                    busy ||
                    recording.phase === "finished" ||
                    recording.phase === "incomplete"
                  }
                  key={preStep.id}
                  onClick={() => {
                    void runResult(() =>
                      armCondition({
                        payload: {
                          data: { index, scope: "flow" },
                          type: "recording.pre-step.condition.arm",
                        },
                      })
                    );
                  }}
                  size="xs"
                  variant="outline"
                >
                  Pick condition for Pre-step {index + 1}
                </Button>
              ))}
            </section>
          ) : null}

          <section
            aria-labelledby="recorded-steps-heading"
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium" id="recorded-steps-heading">
                Steps
              </h3>
              <Badge variant="outline">
                {recording?.recordedSteps.length ?? 0} Steps
              </Badge>
            </div>
            {recording === null ? (
              <div className="bg-muted/20 grid min-h-36 place-items-center rounded-lg border border-dashed p-5 text-center">
                <div className="space-y-2">
                  <ListChecksIcon
                    aria-hidden="true"
                    className="text-muted-foreground mx-auto size-5"
                  />
                  <p className="text-sm font-medium">No Recording yet</p>
                  <p className="text-muted-foreground text-xs">
                    Name the Flow and start recording browser actions.
                  </p>
                </div>
              </div>
            ) : (
              <ol className="space-y-2">
                {recording.recordedSteps.map((step, index) => (
                  <StepCard
                    busy={busy}
                    index={index}
                    key={step.id}
                    onAudit={setStepAudit}
                    onDelete={(stepId) => {
                      void runResult(() =>
                        deleteStep({
                          payload: {
                            data: { stepId },
                            type: "recording.step.delete",
                          },
                        })
                      );
                    }}
                    onCondition={(stepId, preStepIndex) => {
                      void runResult(() =>
                        armCondition({
                          payload: {
                            data: {
                              index: preStepIndex,
                              scope: "step",
                              stepId,
                            },
                            type: "recording.pre-step.condition.arm",
                          },
                        })
                      );
                    }}
                    onPreStep={(stepId) => {
                      void runResult(() =>
                        armPreStep({
                          payload: {
                            data: { scope: "step", stepId },
                            type: "recording.pre-step.arm",
                          },
                        })
                      );
                    }}
                    onSecret={(stepId, name) => {
                      void runResult(() =>
                        bindSecret({
                          payload: {
                            data: { name, stepId },
                            type: "recording.step.secret.bind",
                          },
                        })
                      );
                    }}
                    recording={recording}
                    secretVariables={
                      recording.flow.contingency?.secretVariables?.map(
                        ({ name }) => name
                      ) ?? []
                    }
                    step={step}
                  />
                ))}
              </ol>
            )}
          </section>

          {recording === null ||
          recording.phase === "finished" ||
          recording.phase === "incomplete" ? null : (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || recording.captureMode !== "ordinary"}
                onClick={() => {
                  void runResult(() =>
                    armPreStep({
                      payload: {
                        data: { scope: "flow" },
                        type: "recording.pre-step.arm",
                      },
                    })
                  );
                }}
                size="sm"
                variant="outline"
              >
                Add Flow Pre-step
              </Button>
              <Button
                disabled={busy || !recording.undoAvailable}
                onClick={() => {
                  void runResult(() =>
                    undoDelete({
                      payload: { data: {}, type: "recording.step.undo" },
                    })
                  );
                }}
                size="sm"
                variant="outline"
              >
                <RotateCcwIcon />
                Undo delete
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      <RecordingControls
        busy={busy}
        confirmDiscard={confirmDiscard}
        onDiscard={discardRecording}
        onFinish={() => {
          void runResult(() =>
            finish({ payload: { data: {}, type: "recording.finish" } })
          );
        }}
        onPause={() => {
          void runResult(() =>
            pause({ payload: { data: {}, type: "recording.pause" } })
          );
        }}
        onResume={() => {
          void runResult(() =>
            resume({ payload: { data: {}, type: "recording.resume" } })
          );
        }}
        onStart={startRecording}
        recording={recording}
        startDisabled={startDisabled}
      />
    </aside>
  );
};

export { InstructionsPanel };
