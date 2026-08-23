import type { AuditKind, RecordingSnapshot } from "@contingency/protocol";
import { isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";

import {
  createWorkspaceAtom,
  recordingAuthoringUiAtom,
} from "@/components/create/create-workspace-state";
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
  recordingVariableBindMutation,
  recordingVariableRenameMutation,
  recordingStartMutation,
  recordingStepDeleteMutation,
  recordingStepUndoMutation,
  recordingTitleMutation,
} from "@/lib/rpc";

const errorMessage = (error: unknown): string =>
  error instanceof Error || isBrowserRpcError(error)
    ? error.message
    : "Unable to update the Recording.";

interface RecordingResult {
  readonly data: { readonly recording: RecordingSnapshot | null };
}

export interface RecordingAuthoringController {
  readonly addAudit: (audit: AuditKind) => void;
  readonly armFlowCondition: (index: number) => void;
  readonly armFlowPreStep: () => void;
  readonly armStepCondition: (stepId: string, index: number) => void;
  readonly armStepPreStep: (stepId: string) => void;
  readonly bindVariable: (stepId: string, name: string) => void;
  readonly busy: boolean;
  readonly cancelCapture: () => void;
  readonly confirmDiscard: boolean;
  readonly deleteStep: (stepId: string) => void;
  readonly discard: () => void;
  readonly error: string | undefined;
  readonly finish: () => void;
  readonly pause: () => void;
  readonly recording: RecordingSnapshot | null;
  readonly recover: () => void;
  readonly renameVariable: (from: string, name: string) => void;
  readonly resume: () => void;
  readonly saveTitle: () => void;
  readonly setTitle: (title: string) => void;
  readonly start: () => void;
  readonly startDisabled: boolean;
  readonly title: string;
  readonly undoDelete: () => void;
}

export const useRecordingAuthoring = (): RecordingAuthoringController => {
  const [workspace, setWorkspace] = useAtom(createWorkspaceAtom);
  const [ui, setUi] = useAtom(recordingAuthoringUiAtom);
  const startMutation = useAtomSet(recordingStartMutation, { mode: "promise" });
  const pauseMutation = useAtomSet(recordingPauseMutation, { mode: "promise" });
  const resumeMutation = useAtomSet(recordingResumeMutation, {
    mode: "promise",
  });
  const recoverMutation = useAtomSet(recordingRecoverMutation, {
    mode: "promise",
  });
  const finishMutation = useAtomSet(recordingFinishMutation, {
    mode: "promise",
  });
  const discardMutation = useAtomSet(recordingDiscardMutation, {
    mode: "promise",
  });
  const titleMutation = useAtomSet(recordingTitleMutation, { mode: "promise" });
  const deleteMutation = useAtomSet(recordingStepDeleteMutation, {
    mode: "promise",
  });
  const undoMutation = useAtomSet(recordingStepUndoMutation, {
    mode: "promise",
  });
  const auditMutation = useAtomSet(recordingAuditMutation, { mode: "promise" });
  const bindVariableMutation = useAtomSet(recordingVariableBindMutation, {
    mode: "promise",
  });
  const renameVariableMutation = useAtomSet(recordingVariableRenameMutation, {
    mode: "promise",
  });
  const preStepMutation = useAtomSet(recordingPreStepMutation, {
    mode: "promise",
  });
  const conditionMutation = useAtomSet(recordingPreStepConditionMutation, {
    mode: "promise",
  });
  const cancelMutation = useAtomSet(recordingCaptureCancelMutation, {
    mode: "promise",
  });
  const { address, recording, selectedSessionId } = workspace;
  const { busy, confirmDiscard, error, titleDraft } = ui;
  const title = titleDraft ?? recording?.flow.title ?? "";

  const applyRecording = (next: RecordingSnapshot | null) => {
    setWorkspace((current) => ({ ...current, recording: next }));
  };

  const run = async (operation: () => Promise<RecordingSnapshot | null>) => {
    if (busy) {
      return false;
    }
    setUi((current) => ({ ...current, busy: true, error: undefined }));
    try {
      applyRecording(await operation());
      return true;
    } catch (operationError) {
      setUi((current) => ({
        ...current,
        error: errorMessage(operationError),
      }));
      return false;
    } finally {
      setUi((current) => ({ ...current, busy: false }));
    }
  };

  const runResult = (operation: () => Promise<RecordingResult>) =>
    run(async () => {
      const result = await operation();
      return result.data.recording;
    });
  const invoke = (operation: () => Promise<RecordingResult>) => {
    void runResult(operation);
  };

  const discard = () => {
    const hasAuthoredContent =
      recording !== null &&
      (recording.recordedSteps.length > 1 ||
        (recording.flow.preSteps?.length ?? 0) > 0 ||
        (recording.flow.variables?.length ?? 0) > 0);
    if (hasAuthoredContent && !confirmDiscard) {
      setUi((current) => ({ ...current, confirmDiscard: true }));
      return;
    }
    const discardAndReset = async () => {
      const succeeded = await run(async () => {
        await discardMutation({
          payload: { data: {}, type: "recording.discard" },
        });
        return null;
      });
      if (succeeded) {
        setUi((current) => ({
          ...current,
          confirmDiscard: false,
          titleDraft: undefined,
        }));
      }
    };
    void discardAndReset();
  };

  return {
    addAudit: (audit) =>
      invoke(() =>
        auditMutation({
          payload: { data: { audit }, type: "recording.audit.add" },
        })
      ),
    armFlowCondition: (index) =>
      invoke(() =>
        conditionMutation({
          payload: {
            data: { index, scope: "flow" },
            type: "recording.pre-step.condition.arm",
          },
        })
      ),
    armFlowPreStep: () =>
      invoke(() =>
        preStepMutation({
          payload: {
            data: { scope: "flow" },
            type: "recording.pre-step.arm",
          },
        })
      ),
    armStepCondition: (stepId, index) =>
      invoke(() =>
        conditionMutation({
          payload: {
            data: { index, scope: "step", stepId },
            type: "recording.pre-step.condition.arm",
          },
        })
      ),
    armStepPreStep: (stepId) =>
      invoke(() =>
        preStepMutation({
          payload: {
            data: { scope: "step", stepId },
            type: "recording.pre-step.arm",
          },
        })
      ),
    bindVariable: (stepId, name) =>
      invoke(() =>
        bindVariableMutation({
          payload: {
            data: { name, stepId },
            type: "recording.step.variable.bind",
          },
        })
      ),
    busy,
    cancelCapture: () =>
      invoke(() =>
        cancelMutation({
          payload: { data: {}, type: "recording.capture.cancel" },
        })
      ),
    confirmDiscard,
    deleteStep: (stepId) =>
      invoke(() =>
        deleteMutation({
          payload: { data: { stepId }, type: "recording.step.delete" },
        })
      ),
    discard,
    error,
    finish: () =>
      invoke(() =>
        finishMutation({ payload: { data: {}, type: "recording.finish" } })
      ),
    pause: () =>
      invoke(() =>
        pauseMutation({ payload: { data: {}, type: "recording.pause" } })
      ),
    recording,
    recover: () =>
      invoke(() =>
        recoverMutation({ payload: { data: {}, type: "recording.recover" } })
      ),
    renameVariable: (from, name) =>
      invoke(() =>
        renameVariableMutation({
          payload: {
            data: { from, name },
            type: "recording.variable.rename",
          },
        })
      ),
    resume: () =>
      invoke(() =>
        resumeMutation({ payload: { data: {}, type: "recording.resume" } })
      ),
    saveTitle: () => {
      if (recording !== null && title !== recording.flow.title) {
        invoke(() =>
          titleMutation({
            payload: { data: { title }, type: "recording.title.update" },
          })
        );
      }
    },
    setTitle: (nextTitle) =>
      setUi((current) => ({ ...current, titleDraft: nextTitle })),
    start: () => {
      if (selectedSessionId !== undefined) {
        invoke(() =>
          startMutation({
            payload: {
              data: { sessionId: selectedSessionId, title },
              type: "recording.start",
            },
          })
        );
      }
    },
    startDisabled:
      busy ||
      selectedSessionId === undefined ||
      address.trim().length === 0 ||
      title.trim().length === 0,
    title,
    undoDelete: () =>
      invoke(() =>
        undoMutation({ payload: { data: {}, type: "recording.step.undo" } })
      ),
  };
};
