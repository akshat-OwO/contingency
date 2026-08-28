import { isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Fiber, Result } from "effect";
import { useCallback, useEffect } from "react";

import { AttemptPlayer } from "@/components/audit/attempt-player";
import {
  auditActionErrorAtom,
  auditBusyAtom,
  auditStreamErrorAtom,
  auditVariableDraftAtom,
  auditWorkspaceAtom,
  gateBreach,
  selectedAttempt,
  selectedStepIndex,
  timelineSteps,
} from "@/components/audit/audit-workspace-state";
import { FlowUpload } from "@/components/audit/flow-upload";
import { RunHeader } from "@/components/audit/run-header";
import { StepDetail } from "@/components/audit/step-detail";
import { StepFindings } from "@/components/audit/step-findings";
import { StepTimeline } from "@/components/audit/step-timeline";
import { VariablePrompt } from "@/components/audit/variable-prompt";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  runAtom,
  runFlowLoadMutation,
  runStartMutation,
  runRunProgressStream,
  runVariableAnswerMutation,
} from "@/lib/rpc";

const errorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "The Runner could not answer.";

const NoFlow = ({
  busy,
  error,
  onLoad,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onLoad: (document: string, source: string) => void;
}) => (
  <main className="grid h-[calc(100svh-3.5rem)] place-items-center p-6">
    <section className="max-w-md space-y-4 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          No Flow to audit
        </h1>
        <p className="text-muted-foreground text-sm">
          Audit View runs one Flow at a time. Start the server with{" "}
          <code className="font-mono">contingency web &lt;flow&gt;</code>, or
          open a Flow file from here.
        </p>
      </div>
      <div className="flex justify-center">
        <FlowUpload
          busy={busy}
          label="Open a Flow file"
          onLoad={onLoad}
          size="default"
          variant="default"
        />
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>That Flow could not be loaded</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {error}
          </AlertDescription>
        </Alert>
      )}
    </section>
  </main>
);

const AuditWorkspace = () => {
  const [workspace, setWorkspace] = useAtom(auditWorkspaceAtom);
  const [streamError, setStreamError] = useAtom(auditStreamErrorAtom);
  const [draft, setDraft] = useAtom(auditVariableDraftAtom);
  const [busy, setBusy] = useAtom(auditBusyAtom);
  const [actionError, setActionError] = useAtom(auditActionErrorAtom);
  const runResult = useAtomValue(runAtom);
  const start = useAtomSet(runStartMutation, { mode: "promise" });
  const answer = useAtomSet(runVariableAnswerMutation, { mode: "promise" });
  const loadFlow = useAtomSet(runFlowLoadMutation, { mode: "promise" });

  /**
   * One shape for both requests: a refusal is the Runner's answer and must be
   * shown, not swallowed. Matches how Create View drives its own mutations.
   */
  const request = useCallback(
    (operation: () => Promise<unknown>) => {
      if (busy) {
        return;
      }
      setBusy(true);
      setActionError(null);
      void (async () => {
        try {
          await operation();
        } catch (error) {
          setActionError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, setActionError, setBusy]
  );

  useEffect(() => {
    if (runResult._tag !== "Success") {
      return;
    }
    setWorkspace((current) => ({ ...current, run: runResult.value.data.run }));
  }, [runResult, setWorkspace]);

  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.gen(function* observeRun() {
        const outcome = yield* Effect.result(
          runRunProgressStream((run) =>
            Effect.sync(() => {
              setStreamError(null);
              setWorkspace((current) => ({ ...current, run }));
            })
          )
        );
        if (Result.isFailure(outcome)) {
          setStreamError(
            outcome.failure instanceof Error
              ? outcome.failure.message
              : "The Run connection ended unexpectedly."
          );
        }
      })
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [setStreamError, setWorkspace]);

  const { run } = workspace;

  const onStart = useCallback(() => {
    // A fresh Run replaces what the reader was looking at, so the attempt and
    // the pinned Step go back to following the Runner.
    setWorkspace((current) => ({
      ...current,
      attempt: undefined,
      pinnedStep: undefined,
    }));
    request(() => start({ payload: { data: {}, type: "run.start" } }));
  }, [request, setWorkspace, start]);

  const onLoadFlow = useCallback(
    (document: string, source: string) => {
      // A different Flow is a different timeline: nothing the reader had
      // pinned survives it.
      setWorkspace((current) => ({
        ...current,
        attempt: undefined,
        pinnedStep: undefined,
      }));
      request(() =>
        loadFlow({
          payload: { data: { document, source }, type: "run.flow.load" },
        })
      );
    },
    [loadFlow, request, setWorkspace]
  );

  const onAnswer = useCallback(() => {
    const name = run?.variablePrompt?.name;
    if (name === undefined) {
      return;
    }
    request(async () => {
      await answer({
        payload: { data: { name, value: draft }, type: "run.variable.answer" },
      });
      setDraft("");
    });
  }, [answer, draft, request, run?.variablePrompt?.name, setDraft]);

  if (run === null) {
    return <NoFlow busy={busy} error={actionError} onLoad={onLoadFlow} />;
  }

  const attempt = selectedAttempt(run, workspace.attempt);
  const timeline = timelineSteps(run, attempt);
  const selected = selectedStepIndex(timeline, run, workspace.pinnedStep);
  const step = timeline.find(({ index }) => index === selected);
  // Which Step is blocked on the prompt: the one the Runner is executing.
  const asking = timeline.find(({ state }) => state === "running");

  return (
    <main className="flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden">
      <RunHeader
        busy={busy}
        onLoadFlow={onLoadFlow}
        onStart={onStart}
        run={run}
        timeline={timeline}
      />

      {(run.error !== undefined ||
        actionError !== null ||
        streamError !== null) && (
        <Alert className="m-2" variant="destructive">
          <AlertTitle>
            {streamError === null ? "The Run did not start" : "Disconnected"}
          </AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {streamError ?? actionError ?? run.error}
          </AlertDescription>
        </Alert>
      )}

      {run.warnings.length > 0 && (
        <Alert className="m-2">
          <AlertTitle>Before this Run</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {run.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr_20rem]">
        <StepTimeline
          attempt={attempt}
          onFollow={() =>
            setWorkspace((current) => ({ ...current, pinnedStep: undefined }))
          }
          onPin={(index) =>
            setWorkspace((current) => ({ ...current, pinnedStep: index }))
          }
          onSelectAttempt={(chosen) =>
            setWorkspace((current) => ({ ...current, attempt: chosen }))
          }
          pinned={workspace.pinnedStep}
          run={run}
          selected={selected}
          timeline={timeline}
        />

        <div className="flex min-h-0 flex-col">
          <AttemptPlayer
            attempt={attempt}
            className="h-[42%] min-h-40 border-b"
            onPinStep={(index) =>
              setWorkspace((current) => ({ ...current, pinnedStep: index }))
            }
            run={run}
            stepIndex={selected}
            timeline={timeline}
          />
          <StepDetail step={step} />
        </div>

        <StepFindings breached={gateBreach(run) ?? []} step={step} />
      </div>

      <VariablePrompt
        busy={busy}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={onAnswer}
        prompt={run.variablePrompt}
        retries={run.attemptCeiling > 1}
        step={
          asking === undefined
            ? undefined
            : `Step ${asking.index} · ${asking.label}`
        }
      />
    </main>
  );
};

export { AuditWorkspace };
