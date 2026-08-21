import type {
  PreStep,
  RecordedStep,
  RecordingSnapshot,
} from "@contingency/protocol";
import { hasAuthoredBrowserStep } from "@contingency/protocol";
import {
  DownloadIcon,
  InfoIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";

import type { RecordingAuthoringController } from "@/components/create/recording-authoring-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const stepLabel = (
  step: RecordedStep["step"] | PreStep["step"],
  variable?: string
): string => {
  if (step.type === "customStep") {
    return "Accessibility Audit";
  }
  if (step.type === "navigate") {
    try {
      return `Navigate to ${new URL(step.url).hostname}`;
    } catch {
      return "Navigate";
    }
  }
  if (step.type === "change") {
    return variable === undefined
      ? "Change form value"
      : `Enter {{${variable}}}`;
  }
  if (step.type === "click") {
    return "Click element";
  }
  return `${step.type === "keyDown" ? "Press" : "Release"} ${step.key}`;
};

const selectorLabel = (recorded: RecordedStep): string | undefined => {
  if (recorded.step.type === "customStep") {
    return "Contingency custom Step";
  }
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
  readonly controller: RecordingAuthoringController;
  readonly index: number;
  readonly variables: readonly string[];
  readonly step: RecordedStep;
}

const StepCard = ({ controller, index, variables, step }: StepCardProps) => {
  const { busy, recording } = controller;
  if (recording === null) {
    return null;
  }
  const frozen =
    recording.phase === "finished" || recording.phase === "incomplete";
  const initial = index === 0;
  const audit = step.step.type === "customStep";

  return (
    <li className="bg-card space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <Badge className="mt-0.5 tabular-nums" variant="outline">
          {index + 1}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {stepLabel(step.step, step.variable)}
          </p>
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
                    onClick={() =>
                      controller.armStepCondition(step.id, preStepIndex)
                    }
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
            onClick={() => controller.deleteStep(step.id)}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {initial || audit ? null : (
          <Button
            disabled={busy || frozen}
            onClick={() => controller.armStepPreStep(step.id)}
            size="xs"
            variant="outline"
          >
            Add Pre-step
          </Button>
        )}
        {step.step.type === "change" && step.variable === undefined ? (
          <Button
            disabled={busy || frozen}
            onClick={() => controller.bindVariable(step.id, "SECRET")}
            size="xs"
            variant="outline"
          >
            Mark secret
          </Button>
        ) : null}
        {step.step.type === "change" && step.variable !== undefined ? (
          <select
            aria-label={`Variable for Step ${index + 1}`}
            className="bg-background h-7 rounded-md border px-2 text-xs"
            disabled={busy || frozen}
            onChange={(event) =>
              controller.bindVariable(step.id, event.target.value)
            }
            value={step.variable}
          >
            {variables.map((name) => (
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

export const PanelHeader = ({
  recording,
}: {
  readonly recording: RecordingSnapshot | null;
}) => (
  <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
    <h2 className="text-sm font-medium" id="flow-authoring-heading">
      Flow authoring
    </h2>
    {recording === null ? null : (
      <Badge
        variant={recording.phase === "incomplete" ? "destructive" : "outline"}
      >
        {recording.phase}
      </Badge>
    )}
  </div>
);

export const RecordingSetup = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { busy, error, recording, title } = controller;
  return (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="flow-title">
          Flow title
        </label>
        <Input
          disabled={busy || recording?.phase === "finished"}
          id="flow-title"
          onBlur={controller.saveTitle}
          onChange={(event) => controller.setTitle(event.target.value)}
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
            onClick={controller.recover}
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
            onClick={controller.cancelCapture}
            size="sm"
            variant="outline"
          >
            Cancel Pre-step
          </Button>
        </div>
      ) : null}
      <Separator />
    </>
  );
};

export const VariablesSection = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { busy, recording } = controller;
  const variables = recording?.flow.contingency?.variables ?? [];
  if (recording === null || variables.length === 0) {
    return null;
  }
  const frozen =
    recording.phase === "finished" || recording.phase === "incomplete";
  return (
    <section aria-labelledby="variables-heading" className="space-y-2">
      <h3 className="text-sm font-medium" id="variables-heading">
        Variables
      </h3>
      {variables.map(({ name }) => (
        <Input
          aria-label={`Rename ${name}`}
          defaultValue={name}
          disabled={busy || frozen}
          key={name}
          onBlur={(event) => {
            if (event.target.value !== name) {
              controller.renameVariable(name, event.target.value);
            }
          }}
        />
      ))}
    </section>
  );
};

export const FlowPreStepsSection = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { busy, recording } = controller;
  const preSteps = recording?.flow.contingency?.preSteps ?? [];
  if (recording === null || preSteps.length === 0) {
    return null;
  }
  const frozen =
    recording.phase === "finished" || recording.phase === "incomplete";
  return (
    <section aria-labelledby="flow-pre-steps-heading" className="space-y-2">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium" id="flow-pre-steps-heading">
          Flow Pre-steps
        </h3>
        <Tooltip>
          <TooltipTrigger
            aria-label="About Flow Pre-steps"
            className="text-muted-foreground hover:text-foreground inline-flex rounded-sm"
          >
            <InfoIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            Runs before every Step after the starting navigation.
          </TooltipContent>
        </Tooltip>
      </div>
      <ol className="space-y-2">
        {preSteps.map((preStep, index) => {
          const [selector] = preStep.step.selectors;
          const selectorText =
            typeof selector === "string" ? selector : selector?.join(" → ");
          return (
            <li
              className="bg-card space-y-3 rounded-lg border p-3"
              key={preStep.id}
            >
              <div className="flex items-start gap-3">
                <Badge className="mt-0.5 tabular-nums" variant="outline">
                  {index + 1}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {stepLabel(preStep.step)}
                  </p>
                  <p
                    className="text-muted-foreground truncate text-xs"
                    title={selectorText}
                  >
                    {selectorText}
                  </p>
                </div>
              </div>
              <Button
                disabled={busy || frozen}
                onClick={() => controller.armFlowCondition(index)}
                size="xs"
                variant="outline"
              >
                Pick condition
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

export const RecordedStepsSection = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { recording } = controller;
  const variables =
    recording?.flow.contingency?.variables?.map(({ name }) => name) ?? [];
  return (
    <section aria-labelledby="recorded-steps-heading" className="space-y-3">
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
              controller={controller}
              index={index}
              key={step.id}
              variables={variables}
              step={step}
            />
          ))}
        </ol>
      )}
    </section>
  );
};

export const AuthoringActions = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { busy, recording } = controller;
  if (
    recording === null ||
    recording.phase === "finished" ||
    recording.phase === "incomplete"
  ) {
    return null;
  }
  const captureBusy = busy || recording.captureMode !== "ordinary";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        disabled={captureBusy}
        onClick={controller.armFlowPreStep}
        size="sm"
        variant="outline"
      >
        Add Flow Pre-step
      </Button>
      <Button
        disabled={captureBusy}
        onClick={() => controller.addAudit("accessibility")}
        size="sm"
        variant="outline"
      >
        Add accessibility Audit
      </Button>
      <Button
        disabled={busy || !recording.undoAvailable}
        onClick={controller.undoDelete}
        size="sm"
        variant="outline"
      >
        <RotateCcwIcon />
        Undo delete
      </Button>
    </div>
  );
};

export const RecordingControls = ({
  controller,
}: {
  readonly controller: RecordingAuthoringController;
}) => {
  const { busy, confirmDiscard, recording } = controller;
  const finishDisabled =
    busy ||
    recording === null ||
    !hasAuthoredBrowserStep(recording.recordedSteps) ||
    recording.captureMode !== "ordinary";
  return (
    <div className="shrink-0 space-y-2 border-t p-4">
      {recording === null ? (
        <Button
          className="w-full"
          disabled={controller.startDisabled}
          onClick={controller.start}
        >
          <PlayIcon data-icon="inline-start" />
          Start Recording
        </Button>
      ) : null}
      {recording?.phase === "active" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={busy || recording.captureMode !== "ordinary"}
            onClick={controller.pause}
            variant="outline"
          >
            <PauseIcon />
            Pause
          </Button>
          <Button disabled={finishDisabled} onClick={controller.finish}>
            <SquareIcon />
            Finish
          </Button>
        </div>
      ) : null}
      {recording?.phase === "paused" ? (
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={busy || recording.captureMode !== "ordinary"}
            onClick={controller.resume}
          >
            <PlayIcon />
            Resume
          </Button>
          <Button
            disabled={finishDisabled}
            onClick={controller.finish}
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
          onClick={controller.discard}
          variant="ghost"
        >
          <Trash2Icon />
          {confirmDiscard ? "Confirm discard" : "Discard"}
        </Button>
      )}
    </div>
  );
};
