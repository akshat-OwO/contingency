import type { AuditKind, RecordingSnapshot } from "@contingency/protocol";
import { isBrowserRpcError } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { createWorkspaceAtom } from "@/components/create/create-workspace-state";
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

interface RecordingResult {
  readonly data: { readonly recording: RecordingSnapshot | null };
}

export interface RecordingAuthoringController {
  readonly addAudit: (audit: AuditKind) => void;
  readonly armFlowCondition: (index: number) => void;
  readonly armFlowPreStep: () => void;
  readonly armStepCondition: (stepId: string, index: number) => void;
  readonly armStepPreStep: (stepId: string) => void;
  readonly bindSecret: (stepId: string, name: string) => void;
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
  readonly renameSecret: (from: string, name: string) => void;
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
  const [title, setTitle] = useState(workspace.recording?.flow.title ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string>();
  const serverTitleRef = useRef(workspace.recording?.flow.title);
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
  const bindSecretMutation = useAtomSet(recordingSecretBindMutation, {
    mode: "promise",
  });
  const renameSecretMutation = useAtomSet(recordingSecretRenameMutation, {
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
        (recording.flow.contingency?.preSteps?.length ?? 0) > 0 ||
        (recording.flow.contingency?.secretVariables?.length ?? 0) > 0);
    if (hasAuthoredContent && !confirmDiscard) {
      setConfirmDiscard(true);
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
        setConfirmDiscard(false);
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
    bindSecret: (stepId, name) =>
      invoke(() =>
        bindSecretMutation({
          payload: {
            data: { name, stepId },
            type: "recording.step.secret.bind",
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
    renameSecret: (from, name) =>
      invoke(() =>
        renameSecretMutation({
          payload: {
            data: { from, name },
            type: "recording.secret.rename",
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
    setTitle,
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
