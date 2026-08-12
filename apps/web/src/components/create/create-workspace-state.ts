import type { RecordingSnapshot, SessionId } from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

export interface CreateWorkspaceState {
  readonly activeTabId: string | undefined;
  readonly address: string;
  readonly recording: RecordingSnapshot | null;
  readonly selectedSessionId: SessionId | undefined;
}

export const createWorkspaceAtom = Atom.make<CreateWorkspaceState>({
  activeTabId: undefined,
  address: "",
  recording: null,
  selectedSessionId: undefined,
});

export const recordingLocksBrowser = (
  recording: RecordingSnapshot | null
): boolean => recording !== null && recording.phase !== "finished";

export const recordingMakesCanvasReadOnly = (
  recording: RecordingSnapshot | null
): boolean =>
  recording?.phase === "incomplete" ||
  (recording?.phase === "paused" && recording.captureMode === "ordinary");
